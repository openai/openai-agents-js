import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  FinancialReportData,
  FinancialSearchPlan,
  VerificationResult,
} from './agents';
import { FinancialResearchManager } from './manager';

const initialReport: FinancialReportData = {
  short_summary: 'Initial summary',
  markdown_report: 'Initial report',
  follow_up_questions: [],
};

const revisedReport: FinancialReportData = {
  short_summary: 'Revised summary',
  markdown_report: 'Revised report',
  follow_up_questions: [],
};

class TestFinancialResearchManager extends FinancialResearchManager {
  verificationCalls = 0;
  revisionCalls = 0;
  verificationFailuresBeforePass = 0;

  async planSearches(): Promise<FinancialSearchPlan> {
    return { searches: [] };
  }

  async performSearches(): Promise<string[]> {
    return ['Primary source summary'];
  }

  async writeReport(): Promise<FinancialReportData> {
    return initialReport;
  }

  async verifyReport(
    _report: FinancialReportData,
  ): Promise<VerificationResult> {
    this.verificationCalls++;
    if (this.verificationCalls <= this.verificationFailuresBeforePass) {
      return {
        verified: false,
        issues: `Resolve verification issue ${this.verificationCalls}.`,
      };
    }
    return { verified: true, issues: '' };
  }

  async reviseReport(
    _query: string,
    _report: FinancialReportData,
    _verification: VerificationResult,
    _searchResults: string[],
  ): Promise<FinancialReportData> {
    this.revisionCalls++;
    return {
      ...revisedReport,
      short_summary: `Revised summary ${this.revisionCalls}`,
    };
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('revises and re-verifies until the report passes verification', async () => {
  const manager = new TestFinancialResearchManager();
  manager.verificationFailuresBeforePass = 2;

  await manager.run('Research query');

  expect(manager.revisionCalls).toBe(2);
  expect(manager.verificationCalls).toBe(3);
});

test('does not revise a report that passes verification', async () => {
  const manager = new TestFinancialResearchManager();

  await manager.run('Research query');

  expect(manager.revisionCalls).toBe(0);
  expect(manager.verificationCalls).toBe(1);
});
