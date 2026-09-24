import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CodeReviewOrchestrator } from '../src/orchestrator.js';
import {
  ReviewReportSchema,
  ReviewReportJSONSchema
} from '../src/types/report-types.js';
import { ErrorCodes, ReviewError } from '../src/utils/error-handler.js';

const validReport = {
  pullRequest: {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 1
  },
  fileReviews: [],
  summary: {
    totalFiles: 0,
    overallScore: 100,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 0
  },
  recommendations: [],
  metadata: {
    analyzedAt: new Date().toISOString(),
    duration: 0,
    agentVersions: {
      'code-quality-analyzer': '1.0',
      'test-coverage-analyzer': '1.0',
      'refactoring-suggester': '1.0'
    }
  }
};

describe('CodeReviewOrchestrator', () => {
  const originalModel = process.env.ANTHROPIC_MODEL;

  beforeEach(() => {
    process.env.ANTHROPIC_MODEL = 'test-model';
  });

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalModel;
    }
    vi.restoreAllMocks();
  });

  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });

    it('should accept custom options', () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'custom-model',
        timeoutMs: 5000,
        maxRetries: 1
      });

      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });
  });

  describe('reviewPullRequest validation', () => {
    it('should reject an empty owner', async () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model'
      });

      await expect(
        orchestrator.reviewPullRequest('', 'repo', 1)
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG
      });
    });

    it('should reject an empty repository', async () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model'
      });

      await expect(
        orchestrator.reviewPullRequest('owner', '', 1)
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG
      });
    });

    it('should reject an invalid PR number', async () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model'
      });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 0)
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG
      });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 1.5)
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG
      });
    });

    it('should reject a missing model', async () => {
      delete process.env.ANTHROPIC_MODEL;

      const orchestrator = new CodeReviewOrchestrator({
        model: ''
      });

      await expect(
        orchestrator.reviewPullRequest('owner', 'repo', 1)
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_CONFIG
      });
    });
  });

  describe('ReviewReport schema', () => {
    it('should accept a valid empty report', () => {
      const result = ReviewReportSchema.safeParse(validReport);

      expect(result.success).toBe(true);
    });

    it('should accept scores at 0 and 100', () => {
      const zeroReport = {
        ...validReport,
        summary: {
          ...validReport.summary,
          overallScore: 0
        }
      };

      const maxReport = {
        ...validReport,
        summary: {
          ...validReport.summary,
          overallScore: 100
        }
      };

      expect(ReviewReportSchema.safeParse(zeroReport).success).toBe(true);
      expect(ReviewReportSchema.safeParse(maxReport).success).toBe(true);
    });

    it('should reject an invalid overall score', () => {
      const invalidReport = {
        ...validReport,
        summary: {
          ...validReport.summary,
          overallScore: 101
        }
      };

      expect(ReviewReportSchema.safeParse(invalidReport).success).toBe(false);
    });

    it('should reject an invalid recommendation priority', () => {
      const invalidReport = {
        ...validReport,
        recommendations: [
          {
            priority: 'urgent',
            category: 'security',
            description: 'Test',
            files: []
          }
        ]
      };

      expect(ReviewReportSchema.safeParse(invalidReport).success).toBe(false);
    });

    it('should reject missing required fields', () => {
      const invalidReport = {
        ...validReport,
        summary: {
          totalFiles: 0,
          overallScore: 100
        }
      };

      expect(ReviewReportSchema.safeParse(invalidReport).success).toBe(false);
    });

    it('should reject incorrect field types', () => {
      const invalidReport = {
        ...validReport,
        summary: {
          ...validReport.summary,
          totalFiles: 'zero'
        }
      };

      expect(ReviewReportSchema.safeParse(invalidReport).success).toBe(false);
    });
  });

  describe('JSON schema', () => {
    it('should expose required ReviewReport properties', () => {
      const schema = ReviewReportJSONSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };

      expect(schema.required).toEqual(
        expect.arrayContaining([
          'pullRequest',
          'fileReviews',
          'summary',
          'recommendations',
          'metadata'
        ])
      );

      expect(schema.properties).toEqual(
        expect.objectContaining({
          pullRequest: expect.anything(),
          fileReviews: expect.anything(),
          summary: expect.anything(),
          recommendations: expect.anything(),
          metadata: expect.anything()
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should use ReviewError for configuration failures', async () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: 'test-model'
      });

      try {
        await orchestrator.reviewPullRequest('owner', 'repo', -1);
        throw new Error('Expected reviewPullRequest to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewError);
        expect((error as ReviewError).code).toBe(
          ErrorCodes.INVALID_CONFIG
        );
      }
    });
  });
});
