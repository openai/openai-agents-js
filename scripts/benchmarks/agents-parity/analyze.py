#!/usr/bin/env python3
"""Summarize saved CPU profiles and paired SDK benchmark observations."""
import os
if not __debug__ or 'PYTHONOPTIMIZE' in os.environ:
    raise RuntimeError('Use ordinary Python with PYTHONOPTIMIZE unset')
import collections
import argparse
import json
import math
import random
import statistics
import sys
from pathlib import Path


def profile(path):
    data = json.loads(Path(path).read_text())
    nodes = {node['id']: node for node in data['nodes']}
    weights = collections.Counter()
    for sample, elapsed in zip(data['samples'], data['timeDeltas']):
        weights[sample] += elapsed / 1000
    functions = collections.Counter()
    files = collections.Counter()
    for node_id, weight in weights.items():
        frame = nodes[node_id]['callFrame']
        name = frame['functionName'] or '(anonymous)'
        url = frame['url'] or '(runtime)'
        functions[(name, url, frame['lineNumber'] + 1)] += weight
        files[url] += weight
    total = sum(weights.values())
    print(f'Profile: {path}; sampled elapsed {total:.1f} ms')
    for (name, url, line), weight in functions.most_common(25):
        print(f'{weight:9.2f} ms {100 * weight / total:6.2f}% {name} {url}:{line}')
    print('Files:')
    for url, weight in files.most_common(15):
        print(f'{weight:9.2f} ms {100 * weight / total:6.2f}% {url}')


def percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, math.floor(fraction * len(values)))]


def metric_value(row, metric):
    turns = row.get('timedCompleted', 0)
    if metric == 'turnsPerSecond':
        return turns * 1000 / row['measuredWallMs'] if turns else None
    if metric == 'cpuMsPerTurn':
        cpu = row.get('measuredCpu')
        return (cpu['user'] + cpu['system']) / 1000 / turns if turns and cpu else None
    if metric == 'serverUtilization':
        cpu = row.get('serverMeasuredCpuMs')
        return cpu / row['measuredWallMs'] if turns and cpu is not None else None
    return row.get(metric)


def results(paths, allow_unpaired=False, min_rounds=5):
    output = []
    for path in paths:
        rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
        if not rows:
            raise ValueError(f'No observations in {path}')
        grouped = collections.defaultdict(lambda: collections.defaultdict(list))
        seen = set()
        for row in rows:
            if row.get('errors', 0) or row.get('serverErrors', 0):
                raise ValueError(f'Errors in {path}: {row}')
            if row.get('profiled') or row.get('diagnosticPreload') or row.get('diagnosticOnly') or row.get('timingInvalidForComparison') or row.get('acceptanceEvidence') is False:
                raise ValueError(f'Instrumented run cannot enter comparison: {path}')
            identity = (row['workload'], row['side'], row['round'])
            if identity in seen:
                raise ValueError(f'Duplicate observation in {path}: {identity}')
            seen.add(identity)
            grouped[row['workload']][row['side']].append(row)
        for workload, sides in grouped.items():
            if set(sides) != {'v0', 'v1'} and not allow_unpaired:
                raise ValueError(f'Unpaired workload in {path}: {workload}')
            if any(len(side_rows) < min_rounds for side_rows in sides.values()):
                raise ValueError(f'Need at least {min_rounds} rounds in {path}: {workload}; use --exploratory only for diagnostic inspection')
            observations = [row for side_rows in sides.values() for row in side_rows]
            for field in ('parameters', 'trace', 'count', 'lanes', 'inputs', 'runtime', 'sources'):
                if any(row.get(field) != observations[0].get(field) for row in observations):
                    raise ValueError(f'Changed {field} within {path}: {workload}')
            if set(sides) == {'v0', 'v1'}:
                baseline = {row['round']: row for row in sides['v0']}
                candidate = {row['round']: row for row in sides['v1']}
                if baseline.keys() != candidate.keys():
                    raise ValueError(f'Missing paired rounds in {path}: {workload}')
                for round_id, left in baseline.items():
                    right = candidate[round_id]
                    for field in ('completed', 'timedCompleted', 'expectedRequests', 'serverRequests',
                                  'toolCalls', 'logicalInputBytes', 'logicalOutputBytes',
                                  'measuredInputBytes', 'measuredOutputBytes', 'streamedTextBytes'):
                        if left.get(field) != right.get(field):
                            raise ValueError(f'Unequal work ({field}) in {path}: {workload}, round {round_id}')
            summary = {'acceptanceEstablished': False, 'evidenceClass': 'exploratory' if allow_unpaired or min_rounds < 10 else 'descriptive-comparison', 'file': path, 'workload': workload, 'parameters': observations[0].get('parameters'),
                       'trace': observations[0].get('trace'), 'inputs': observations[0].get('inputs'),
                       'runtime': observations[0].get('runtime'), 'sources': observations[0].get('sources'),
                       'metrics': {}, 'counts': {}}
            for side, side_rows in sides.items():
                summary['counts'][side] = {
                    'rounds': len(side_rows),
                    'completed': sum(row.get('completed', 0) for row in side_rows),
                    'requests': sum(row.get('serverRequests', 0) for row in side_rows),
                }
            metrics = ('importMs', 'facadeImportedFromProcessStartMs', 'firstUsefulFromProcessStartMs', 'firstUsefulAfterConstructionMs',
                       'p50Ms', 'p95Ms', 'firstTextP50Ms', 'turnsPerSecond', 'cpuMsPerTurn',
                       'serverUtilization', 'wallMs', 'lifecycleMs', 'traceFlushMs',
                       'processWallMs', 'rssBytes', 'idleRssBytes', 'peakRssBytes')
            for metric in metrics:
                if any(metric_value(row, metric) is None for row in observations):
                    continue
                direction = 'higher' if metric == 'turnsPerSecond' else 'lower'
                if metric == 'serverUtilization':
                    direction = 'observation'
                entry = {'direction': direction, 'sides': {}}
                for side, side_rows in sides.items():
                    values = [metric_value(row, metric) for row in side_rows]
                    if any(not math.isfinite(value) or value < 0 for value in values):
                        raise ValueError(f'Invalid {metric} in {path}: {workload}')
                    entry['sides'][side] = {'median': statistics.median(values),
                                            'min': min(values), 'max': max(values), 'values': values}
                if set(sides) == {'v0', 'v1'}:
                    baseline_values = {row['round']: metric_value(row, metric) for row in sides['v0']}
                    if all(value > 0 for value in baseline_values.values()):
                        pairs = [(baseline_values[row['round']], metric_value(row, metric)) for row in sides['v1']]
                        rng = random.Random(20261106)
                        boot = []
                        for _ in range(10000):
                            sample = rng.choices(pairs, k=len(pairs))
                            boot.append(statistics.median(right for left, right in sample) /
                                        statistics.median(left for left, right in sample))
                        entry['ratioOfMedians'] = (entry['sides']['v1']['median'] /
                                                   entry['sides']['v0']['median'])
                        entry['ratioOfMedians95PercentPairedBootstrap'] = [percentile(boot, .025), percentile(boot, .975)]
                summary['metrics'][metric] = entry
            output.append(summary)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    if sys.argv[1] == 'profile':
        for filename in sys.argv[2:]:
            profile(filename)
    elif sys.argv[1] == 'results':
        parser = argparse.ArgumentParser()
        parser.add_argument('--allow-unpaired', action='store_true', help='Only for smoke-test inspection')
        parser.add_argument('--exploratory', action='store_true', help='Permit fewer than five rounds; never final evidence')
        parser.add_argument('--min-rounds', type=int, default=5)
        parser.add_argument('paths', nargs='+')
        args = parser.parse_args(sys.argv[2:])
        if args.min_rounds < 5:
            parser.error('--min-rounds must be at least five; use --exploratory for diagnostics')
        results(args.paths, args.allow_unpaired, 1 if args.exploratory else args.min_rounds)
    else:
        raise SystemExit('Usage: analyze.py profile|results FILE ...')
