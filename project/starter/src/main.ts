import * as dotenv from 'dotenv';
dotenv.config();

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import { logger } from './utils/logger.js';
import {
  ReviewError,
  ErrorCodes,
  formatError
} from './utils/error-handler.js';

function printUsage(): void {
  console.error(
    'Usage: npm run dev -- <owner> <repo> <pr-number>'
  );
}

function validateEnvironment(): {
  authMethod: 'Anthropic API' | 'AWS Bedrock';
  model: string;
} {
  const hasAnthropicAPI = Boolean(process.env.ANTHROPIC_API_KEY);

  const hasAWSCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION
  );

  if (!hasAnthropicAPI && !hasAWSCredentials) {
    throw new ReviewError(
      'Authentication is not configured. Set ANTHROPIC_API_KEY or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.',
      ErrorCodes.MISSING_API_KEY
    );
  }

  const model = process.env.ANTHROPIC_MODEL;

  if (!model) {
    throw new ReviewError(
      'ANTHROPIC_MODEL environment variable is required.',
      ErrorCodes.INVALID_CONFIG
    );
  }

  return {
    authMethod: hasAnthropicAPI ? 'Anthropic API' : 'AWS Bedrock',
    model
  };
}

async function main(): Promise<void> {
  const [owner, repo, prStr] = process.argv.slice(2);

  if (!owner || !repo || !prStr) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const prNumber = Number(prStr);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('PR number must be a positive integer.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const { authMethod, model } = validateEnvironment();

    logger.info(`Using ${authMethod} authentication`);
    logger.info(`Model: ${model}`);
    logger.info(
      `Starting review for ${owner}/${repo}#${prNumber}`
    );

    const orchestrator = new CodeReviewOrchestrator({
      model
    });

    const report = await orchestrator.reviewPullRequest(
      owner,
      repo,
      prNumber
    );

    const reportGenerator = new ReportGenerator();

    await reportGenerator.generateReports(report);

    logger.info(
      `Review completed for ${owner}/${repo}#${prNumber}`
    );

    console.log(
      `Review completed successfully: ${owner}/${repo}#${prNumber}`
    );
  } catch (error) {
    const formatted = formatError(error);

    logger.error(formatted);

    console.error(`Error: ${formatted}`);

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    'Unexpected error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
