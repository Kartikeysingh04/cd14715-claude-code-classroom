import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewReport } from './types/report-types.js';
import {
  ReviewReportSchema,
  ReviewReportJSONSchema
} from './types/report-types.js';
import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester
} from './agents/index.js';
import { mcpServersConfig } from './config/mcp.config.js';
import {
  orchestratorPrompt,
  codeQualityPrompt,
  testCoveragePrompt,
  refactoringPrompt
} from './prompts/index.js';
import { rateLimiter } from './utils/rate-limiter.js';
import {
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout
} from './utils/error-handler.js';

export interface OrchestratorOptions {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class CodeReviewOrchestrator {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OrchestratorOptions = {}) {
    this.model = options.model || process.env.ANTHROPIC_MODEL || '';
    this.timeoutMs = options.timeoutMs || 600_000;
    this.maxRetries = options.maxRetries || 3;
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
      throw new ReviewError(
        'Invalid pull request configuration',
        ErrorCodes.INVALID_CONFIG,
        { owner, repo, prNumber }
      );
    }

    if (!this.model) {
      throw new ReviewError(
        'ANTHROPIC_MODEL is required',
        ErrorCodes.INVALID_CONFIG
      );
    }

    const startedAt = Date.now();

    const prompt = `${orchestratorPrompt}

Review this pull request:

Repository owner: ${owner}
Repository: ${repo}
Pull request number: ${prNumber}

Fetch the PR using GitHub MCP before delegating analysis.

Use the code-quality-analyzer agent for code quality analysis.
Use the test-coverage-analyzer agent for test coverage analysis.
Use the refactoring-suggester agent for refactoring analysis.

Aggregate the three agent results into the ReviewReport schema.
`;

    try {
      const result = await withRetry(
        () =>
          rateLimiter.withRateLimit(
            () =>
              withTimeout(
                () => this.executeQuery(prompt),
                this.timeoutMs
              ),
            10_000
          ),
        this.maxRetries
      );

      const report = this.extractStructuredResult(result);

      const validated = ReviewReportSchema.safeParse(report);

      if (!validated.success) {
        throw new ReviewError(
          'Structured review output failed schema validation',
          ErrorCodes.VALIDATION_FAILED,
          {
            issues: validated.error.issues
          }
        );
      }

      const finalReport: ReviewReport = {
        ...validated.data,
        pullRequest: {
          owner,
          repo,
          number: prNumber
        },
        metadata: {
          ...validated.data.metadata,
          analyzedAt: validated.data.metadata.analyzedAt || new Date().toISOString(),
          duration: Date.now() - startedAt,
          agentVersions: {
            'code-quality-analyzer': '1.0',
            'test-coverage-analyzer': '1.0',
            'refactoring-suggester': '1.0'
          }
        }
      };

      return ReviewReportSchema.parse(finalReport);
    } catch (error) {
      if (error instanceof ReviewError) {
        throw error;
      }

      throw new ReviewError(
        `Pull request review failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCodes.AGENT_FAILED,
        { owner, repo, prNumber }
      );
    }
  }

  private async executeQuery(prompt: string): Promise<unknown> {
    const agents = {
      'code-quality-analyzer': {
        ...codeQualityAnalyzer,
        prompt: codeQualityPrompt
      },
      'test-coverage-analyzer': {
        ...testCoverageAnalyzer,
        prompt: testCoveragePrompt
      },
      'refactoring-suggester': {
        ...refactoringSuggester,
        prompt: refactoringPrompt
      }
    };

    const response = query({
      prompt,
      options: {
        model: this.model,
        permissionMode: 'bypassPermissions',
        mcpServers: mcpServersConfig,
        agents,
        allowedTools: [
          'mcp__github__get_pull_request',
          'mcp__github__get_pull_request_files',
          'mcp__github__get_file_contents',
          'mcp__eslint__lint-files',
          'Task',
          'Skill'
        ],
        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema
        },
        maxTurns: 30
      }
    });

    let structuredOutput: unknown = undefined;

    for await (const message of response) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'structured_output' in message
      ) {
        const candidate = (
          message as { structured_output?: unknown }
        ).structured_output;

        if (candidate !== undefined) {
          structuredOutput = candidate;
        }
      }

      if (
        structuredOutput === undefined &&
        typeof message === 'object' &&
        message !== null &&
        'result' in message
      ) {
        const candidate = (message as { result?: unknown }).result;

        if (typeof candidate === 'object' && candidate !== null) {
          structuredOutput = candidate;
        } else if (typeof candidate === 'string') {
          try {
            structuredOutput = JSON.parse(candidate);
          } catch {
            // Ignore ordinary textual result output.
          }
        }
      }
    }

    if (structuredOutput === undefined) {
      throw new ReviewError(
        'Claude Agent SDK did not return structured output',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED
      );
    }

    return structuredOutput;
  }

  private extractStructuredResult(result: unknown): unknown {
    if (
      typeof result === 'object' &&
      result !== null &&
      'structured_output' in result
    ) {
      return (result as { structured_output: unknown }).structured_output;
    }

    return result;
  }
}
