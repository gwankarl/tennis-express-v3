import {
  sellerApplicationEvidenceTypes,
  type SellerApplicationEvidenceData,
} from './application.schema.js';

export type SellerReviewDecision = 'approve' | 'request_changes' | 'reject';
export type SellerRequestedEvidence = SellerApplicationEvidenceData['type'];

export interface SellerReviewDecisionInput {
  expectedRevision: number;
  decision: SellerReviewDecision;
  feedback?: string;
  requestedEvidence?: SellerRequestedEvidence[];
}

export interface NormalizedSellerReviewDecisionInput {
  expectedRevision: number;
  decision: SellerReviewDecision;
  feedback: string | null;
  requestedEvidence: SellerRequestedEvidence[];
}

export class SellerReviewValidationError extends Error {
  constructor(
    readonly field: string,
    readonly rule: string,
  ) {
    super('Seller review input is invalid.');
    this.name = 'SellerReviewValidationError';
  }
}

/**
 * Normalizes feedback and checks category-specific requested evidence before a
 * review transaction is started.
 */
export function normalizeSellerReviewDecisionInput(
  category: 'individual' | 'commercial',
  input: SellerReviewDecisionInput,
): NormalizedSellerReviewDecisionInput {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new SellerReviewValidationError('expectedRevision', 'minimum');
  }

  if (input.feedback !== undefined && typeof input.feedback !== 'string') {
    throw new SellerReviewValidationError('feedback', 'type');
  }

  if (input.feedback !== undefined && [...input.feedback].length > 2000) {
    throw new SellerReviewValidationError('feedback', 'maxLength');
  }

  const feedback = input.feedback?.trim() || null;

  if (input.decision !== 'approve' && feedback === null) {
    throw new SellerReviewValidationError('feedback', 'required');
  }

  const requestedEvidence = input.requestedEvidence ?? [];

  if (input.decision !== 'request_changes' && requestedEvidence.length > 0) {
    throw new SellerReviewValidationError('requestedEvidence', 'decision_not_request_changes');
  }

  if (new Set(requestedEvidence).size !== requestedEvidence.length) {
    throw new SellerReviewValidationError('requestedEvidence', 'duplicate');
  }

  for (const evidenceType of requestedEvidence) {
    if (!sellerApplicationEvidenceTypes.includes(evidenceType)) {
      throw new SellerReviewValidationError('requestedEvidence', 'unsupported_type');
    }

    if (category === 'individual' && evidenceType !== 'applicant_id') {
      throw new SellerReviewValidationError('requestedEvidence', 'type_not_allowed_for_category');
    }
  }

  return {
    expectedRevision: input.expectedRevision,
    decision: input.decision,
    feedback,
    requestedEvidence: [...requestedEvidence],
  };
}
