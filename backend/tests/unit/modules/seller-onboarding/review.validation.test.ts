import { describe, expect, it } from 'vitest';
import {
  normalizeSellerReviewDecisionInput,
  SellerReviewValidationError,
} from '../../../../src/modules/seller-onboarding/review.validation.js';

describe('normalizeSellerReviewDecisionInput', () => {
  it('allows an approval without feedback or requested evidence', () => {
    expect(
      normalizeSellerReviewDecisionInput('individual', {
        expectedRevision: 3,
        decision: 'approve',
      }),
    ).toEqual({
      expectedRevision: 3,
      decision: 'approve',
      feedback: null,
      requestedEvidence: [],
    });
  });

  it.each(['request_changes', 'reject'] as const)(
    'requires applicant-facing feedback for %s',
    (decision) => {
      expect(() =>
        normalizeSellerReviewDecisionInput('individual', {
          expectedRevision: 3,
          decision,
        }),
      ).toThrow(SellerReviewValidationError);
    },
  );

  it('trims request-changes feedback and permits Commercial proof-of-authority requests', () => {
    expect(
      normalizeSellerReviewDecisionInput('commercial', {
        expectedRevision: 4,
        decision: 'request_changes',
        feedback: '  Please provide proof of authority.  ',
        requestedEvidence: ['proof_of_authority'],
      }),
    ).toMatchObject({
      feedback: 'Please provide proof of authority.',
      requestedEvidence: ['proof_of_authority'],
    });
  });

  it('rejects proof of authority requests for Individual applications', () => {
    expect(() =>
      normalizeSellerReviewDecisionInput('individual', {
        expectedRevision: 3,
        decision: 'request_changes',
        feedback: 'Please provide proof.',
        requestedEvidence: ['proof_of_authority'],
      }),
    ).toThrow(SellerReviewValidationError);
  });

  it('rejects requested evidence for decisions other than Request changes', () => {
    expect(() =>
      normalizeSellerReviewDecisionInput('commercial', {
        expectedRevision: 3,
        decision: 'reject',
        feedback: 'This application cannot be approved.',
        requestedEvidence: ['business_registration'],
      }),
    ).toThrow(SellerReviewValidationError);
  });

  it('rejects duplicate requested evidence', () => {
    expect(() =>
      normalizeSellerReviewDecisionInput('commercial', {
        expectedRevision: 3,
        decision: 'request_changes',
        feedback: 'Please update your evidence.',
        requestedEvidence: ['proof_of_authority', 'proof_of_authority'],
      }),
    ).toThrow(SellerReviewValidationError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected revision %s',
    (expectedRevision) => {
      expect(() =>
        normalizeSellerReviewDecisionInput('individual', {
          expectedRevision,
          decision: 'approve',
        }),
      ).toThrow(SellerReviewValidationError);
    },
  );
});
