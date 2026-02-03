#!/usr/bin/env node

import fs from 'fs';

const { fetch, console, process } = globalThis;

function printUsage() {
  console.log('Usage: pnpm changeset:assign-milestone -- <path-to-json>');
}

function readJson(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(contents);
}

function parseMilestoneTitle(title) {
  const match = title.match(/^(\d+)\.(\d+)\.x$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), title };
}

async function assignMilestone(requiredBump) {
  if (requiredBump === 'none') {
    console.log('Milestone assignment skipped (no package changes).');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('Milestone assignment skipped (missing GITHUB_TOKEN).');
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.warn('Milestone assignment skipped (missing GITHUB_EVENT_PATH).');
    return;
  }

  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch (_error) {
    console.warn(
      'Milestone assignment skipped (failed to read event payload).',
    );
    return;
  }

  const owner = event?.repository?.owner?.login;
  const repo = event?.repository?.name;
  const prNumber = event?.pull_request?.number;
  if (!owner || !repo || !prNumber) {
    console.warn(
      'Milestone assignment skipped (missing repository or PR info).',
    );
    return;
  }

  const milestonesResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/milestones?state=open&per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!milestonesResponse.ok) {
    console.warn(
      `Milestone assignment skipped (failed to list milestones: ${milestonesResponse.status}).`,
    );
    return;
  }

  const milestones = await milestonesResponse.json();
  const parsed = milestones
    .map((milestone) => ({
      milestone,
      parsed: parseMilestoneTitle(milestone.title),
    }))
    .filter((entry) => entry.parsed)
    .sort((a, b) => {
      if (a.parsed.major !== b.parsed.major)
        return a.parsed.major - b.parsed.major;
      return a.parsed.minor - b.parsed.minor;
    });

  if (parsed.length === 0) {
    console.warn(
      'Milestone assignment skipped (no open milestones matching X.Y.x).',
    );
    return;
  }

  const majors = Array.from(
    new Set(parsed.map((entry) => entry.parsed.major)),
  ).sort((a, b) => a - b);
  const currentMajor = majors[0];
  const nextMajor = majors[1];

  const currentMajorEntries = parsed.filter(
    (entry) => entry.parsed.major === currentMajor,
  );
  const patchTarget = currentMajorEntries[0];
  const minorTarget = currentMajorEntries[1] ?? patchTarget;

  let majorTarget;
  if (nextMajor !== undefined) {
    const nextMajorEntries = parsed.filter(
      (entry) => entry.parsed.major === nextMajor,
    );
    majorTarget = nextMajorEntries[0];
  }

  let targetEntry;
  if (requiredBump === 'major') {
    targetEntry = majorTarget;
  } else if (requiredBump === 'minor') {
    targetEntry = minorTarget;
  } else {
    targetEntry = patchTarget;
  }
  if (!targetEntry) {
    console.warn(
      'Milestone assignment skipped (not enough open milestones for selection).',
    );
    return;
  }

  const updateResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`,
    {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ milestone: targetEntry.milestone.number }),
    },
  );

  if (!updateResponse.ok) {
    console.warn(
      `Milestone assignment skipped (failed to update PR milestone: ${updateResponse.status}).`,
    );
    return;
  }

  console.log(`Milestone set to ${targetEntry.milestone.title}.`);
}

function main() {
  const inputPath = process.argv
    .slice(2)
    .filter((arg) => arg !== '--')
    .find(Boolean);
  if (!inputPath) {
    printUsage();
    console.warn('Milestone assignment skipped (missing input path).');
    return;
  }

  let data;
  try {
    data = readJson(inputPath);
  } catch (_error) {
    console.warn(
      `Milestone assignment skipped (failed to read JSON from ${inputPath}).`,
    );
    return;
  }

  const requiredBump = data?.required_bump;
  if (!requiredBump) {
    console.warn('Milestone assignment skipped (missing required_bump).');
    return;
  }

  assignMilestone(requiredBump).catch((error) => {
    console.warn(`Milestone assignment skipped: ${error.message}`);
  });
}

main();
