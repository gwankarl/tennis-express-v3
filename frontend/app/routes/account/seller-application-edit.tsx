import { useEffect, useState } from 'react';
import type { Route } from './+types/seller-application-edit';
import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import {
  RestrictedAccountState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import {
  clearSessionCookie,
  loadProtectedUser,
  readSessionToken,
  safeReturnTo,
} from '~/.server/auth/session.js';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from 'react-router';

type Category = 'individual' | 'commercial';
type Status = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';
type FieldName =
  | 'legalName'
  | 'sellerDisplayName'
  | 'areaServed'
  | 'contactPhone'
  | 'registeredBusinessName'
  | 'businessRole'
  | 'storefrontName';

type EvidenceType = 'applicant_id' | 'business_registration' | 'proof_of_authority';

interface EvidenceActionData {
  status: 'uploaded' | 'invalid' | 'blocked' | 'too-large' | 'stale' | 'unavailable';
  type?: EvidenceType;
  revision?: number;
  byteSize?: number;
  mediaType?: 'image/jpeg' | 'image/png' | 'application/pdf';
}

const evidenceLabels: Record<EvidenceType, string> = {
  applicant_id: 'Applicant photo ID',
  business_registration: 'Business registration',
  proof_of_authority: 'Proof of authority',
};

const submissionFieldLabels: Record<string, string> = {
  legalName: 'Applicant’s legal name',
  sellerDisplayName: 'Seller display name',
  areaServed: 'Area served in Yaoundé',
  registeredBusinessName: 'Registered business name',
  businessRole: 'Applicant’s role in the business',
  'evidence.applicant_id': 'Applicant photo ID',
  'evidence.business_registration': 'Business registration',
  'evidence.proof_of_authority': 'Proof of authority',
};

interface SellerApplication {
  id: string;
  category: Category;
  status: Status;
  revision: number;
  legalName: string | null;
  sellerDisplayName: string | null;
  areaServed: string | null;
  contactPhone: string | null;
  registeredBusinessName: string | null;
  businessRole: string | null;
  storefrontName: string | null;
  proofOfAuthorityRequired: boolean;
  evidence: Array<{
    type: 'applicant_id' | 'business_registration' | 'proof_of_authority';
    mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
    byteSize: number;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface ApplicationResponse {
  application: SellerApplication | null;
}

type FormValues = Record<FieldName | 'category', string>;

interface EditorActionData {
  status: 'invalid' | 'blocked' | 'limited' | 'stale' | 'conflict' | 'unavailable' | 'missing';
  message?: string;
  values?: FormValues;
  missingFields?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSellerApplication(value: unknown): value is SellerApplication {
  if (!isRecord(value)) return false;

  const nullableFields: FieldName[] = [
    'legalName',
    'sellerDisplayName',
    'areaServed',
    'contactPhone',
    'registeredBusinessName',
    'businessRole',
    'storefrontName',
  ];

  return (
    typeof value.id === 'string' &&
    (value.category === 'individual' || value.category === 'commercial') &&
    (value.status === 'draft' ||
      value.status === 'submitted' ||
      value.status === 'changes_requested' ||
      value.status === 'approved' ||
      value.status === 'rejected') &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    nullableFields.every((field) => value[field] === null || typeof value[field] === 'string') &&
    typeof value.proofOfAuthorityRequired === 'boolean' &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        (item.type === 'applicant_id' ||
          item.type === 'business_registration' ||
          item.type === 'proof_of_authority') &&
        (item.mediaType === 'image/jpeg' ||
          item.mediaType === 'image/png' ||
          item.mediaType === 'application/pdf') &&
        typeof item.byteSize === 'number' &&
        Number.isInteger(item.byteSize) &&
        item.byteSize >= 1 &&
        item.byteSize <= 10 * 1024 * 1024 &&
        isDateTime(item.updatedAt),
    ) &&
    isDateTime(value.createdAt) &&
    isDateTime(value.updatedAt)
  );
}

function isApplicationResponse(value: unknown): value is ApplicationResponse {
  return (
    isRecord(value) &&
    'application' in value &&
    (value.application === null || isSellerApplication(value.application))
  );
}

function isCancelled(request: Request, error: unknown): boolean {
  return request.signal.aborted || (error instanceof ApiRequestError && error.kind === 'cancelled');
}

function isExpiredSession(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.errorCode === 'REQUEST_ERROR'
  );
}

function isRestrictedAccount(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 403 &&
    error.errorCode === 'ACCOUNT_RESTRICTED'
  );
}

function loginRedirect(request: Request, frontendOrigin: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);

  const url = new URL(request.url);
  const returnTo = safeReturnTo(`${url.pathname}${url.search}`);

  return redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, { headers });
}

function readFormValues(form: URLSearchParams): FormValues {
  const read = (name: FieldName | 'category') => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };

  return {
    category: read('category'),
    legalName: read('legalName'),
    sellerDisplayName: read('sellerDisplayName'),
    areaServed: read('areaServed'),
    contactPhone: read('contactPhone'),
    registeredBusinessName: read('registeredBusinessName'),
    businessRole: read('businessRole'),
    storefrontName: read('storefrontName'),
  };
}

function cleanValue(value: string): string | null {
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

const fieldLimits: Record<FieldName, number> = {
  legalName: 200,
  sellerDisplayName: 200,
  areaServed: 120,
  contactPhone: 40,
  registeredBusinessName: 200,
  businessRole: 120,
  storefrontName: 200,
};

function isCategory(value: string): value is Category {
  return value === 'individual' || value === 'commercial';
}

function getFieldsForCategory(category: Category, values: FormValues) {
  const shared = {
    legalName: cleanValue(values.legalName),
    areaServed: cleanValue(values.areaServed),
    contactPhone: cleanValue(values.contactPhone),
  };

  if (category === 'individual') {
    return {
      ...shared,
      sellerDisplayName: cleanValue(values.sellerDisplayName),
    };
  }

  return {
    ...shared,
    registeredBusinessName: cleanValue(values.registeredBusinessName),
    businessRole: cleanValue(values.businessRole),
    storefrontName: cleanValue(values.storefrontName),
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const protectedUser = await loadProtectedUser(request, config);

  if (protectedUser.status === 'unavailable') {
    return { status: 'unavailable' as const };
  }

  if (protectedUser.status === 'restricted') {
    return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
  }

  try {
    const result = await requestJson<ApplicationResponse>('/me/seller-applications/current', {
      headers: { authorization: `Bearer ${protectedUser.sessionToken}` },
      signal: request.signal,
      validateData: isApplicationResponse,
    });

    return {
      status: 'loaded' as const,
      application: result.application,
      csrfToken: protectedUser.csrfToken,
      newApplication: new URL(request.url).searchParams.get('new') === '1',
    };
  } catch (error) {
    if (isCancelled(request, error)) throw error;

    if (isRestrictedAccount(error)) {
      return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
    }

    if (isExpiredSession(error)) {
      throw loginRedirect(request, config.frontendOrigin);
    }

    return { status: 'unavailable' as const };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));

  if (!sessionToken) {
    return loginRedirect(request, config.frontendOrigin);
  }

  let submittedValues: FormValues | undefined;
  let submittedIntent: 'create' | 'update' | 'submit' | undefined;

  try {
    const outcome = await withProtectedSessionFormRequest(
      request,
      sessionToken,
      config,
      async (form) => {
        const actionIntent = form.get('intent');

        if (actionIntent === 'submit') {
          submittedIntent = 'submit';
          const applicationId = form.get('applicationId');
          const expectedRevision = Number(form.get('expectedRevision'));

          if (
            typeof applicationId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              applicationId,
            ) ||
            !Number.isInteger(expectedRevision) ||
            expectedRevision < 1
          ) {
            return { kind: 'invalid' as const, values: undefined };
          }

          await requestJson<ApplicationResponse>(
            `/me/seller-applications/${applicationId}/submit`,
            {
              method: 'POST',
              headers: { authorization: `Bearer ${sessionToken}` },
              body: { expectedRevision },
              signal: request.signal,
              validateData: isApplicationResponse,
            },
          );

          return { kind: 'submitted' as const };
        }

        const values = readFormValues(form);
        submittedValues = values;

        if (!isCategory(values.category)) {
          return { kind: 'invalid' as const, values };
        }

        const fields = getFieldsForCategory(values.category, values);

        for (const [name, value] of Object.entries(fields) as Array<[FieldName, string | null]>) {
          if (value !== null && [...value].length > fieldLimits[name]) {
            return {
              kind: 'invalid' as const,
              values,
              message: `Use ${fieldLimits[name]} characters or fewer for ${name}.`,
            };
          }
        }

        const intent = form.get('intent');

        if (intent === 'create') {
          submittedIntent = 'create';
          await requestJson<ApplicationResponse>('/me/seller-applications', {
            method: 'POST',
            headers: { authorization: `Bearer ${sessionToken}` },
            body: { category: values.category, ...fields },
            signal: request.signal,
            validateData: isApplicationResponse,
          });

          return { kind: 'saved' as const };
        }

        if (intent !== 'update') {
          return { kind: 'invalid' as const, values };
        }

        submittedIntent = 'update';

        const applicationId = form.get('applicationId');
        const expectedRevision = Number(form.get('expectedRevision'));

        if (
          typeof applicationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            applicationId,
          ) ||
          !Number.isInteger(expectedRevision) ||
          expectedRevision < 1
        ) {
          return { kind: 'invalid' as const, values };
        }

        await requestJson<ApplicationResponse>(`/me/seller-applications/${applicationId}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${sessionToken}` },
          body: {
            expectedRevision,
            category: values.category,
            ...fields,
          },
          signal: request.signal,
          validateData: isApplicationResponse,
        });

        return { kind: 'saved' as const };
      },
    );

    if (outcome.kind === 'saved') {
      return redirect('/account/seller-application/edit');
    }

    if (outcome.kind === 'submitted') {
      return redirect('/account/seller-application');
    }

    return data<EditorActionData>(
      {
        status: 'invalid',
        values: outcome.values,
        message: outcome.message ?? 'Check the form and try again.',
      },
      { status: 400 },
    );
  } catch (error) {
    if (isCancelled(request, error)) throw error;

    if (error instanceof RequestProtectionError) {
      return data<EditorActionData>(
        { status: 'blocked', values: submittedValues },
        { status: error.status },
      );
    }

    if (isRestrictedAccount(error)) {
      return redirect('/account/seller-application');
    }

    if (isExpiredSession(error)) {
      return loginRedirect(request, config.frontendOrigin);
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 409) {
      return data<EditorActionData>(
        {
          status: submittedIntent === 'create' ? 'conflict' : 'stale',
          values: submittedValues,
        },
        { status: 409 },
      );
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
      return data<EditorActionData>(
        { status: 'limited', values: submittedValues },
        { status: 429 },
      );
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 400 &&
      error.errorCode === 'VALIDATION_ERROR'
    ) {
      if (submittedIntent === 'submit') {
        const missingFields = (error.details ?? []).map(
          (detail) => submissionFieldLabels[detail.field] ?? 'Required application information',
        );

        return data<EditorActionData>(
          {
            status: 'missing',
            missingFields: [...new Set(missingFields)],
          },
          { status: 400 },
        );
      }

      return data<EditorActionData>(
        {
          status: 'invalid',
          values: submittedValues,
          message: 'Some application fields need attention. Check the form and try again.',
        },
        { status: 400 },
      );
    }

    return data<EditorActionData>(
      { status: 'unavailable', values: submittedValues },
      { status: 503 },
    );
  }
}

const inputClassName =
  'min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none transition placeholder:text-stone-400 focus:border-forest focus:ring-2 focus:ring-forest/15';

export default function SellerApplicationEditPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const evidenceFetcher = useFetcher<EvidenceActionData>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const application = page.status === 'loaded' ? page.application : null;
  const creating =
    page.status === 'loaded' &&
    (application === null || (application.status === 'rejected' && page.newApplication));
  const editable =
    page.status === 'loaded' &&
    (creating || application?.status === 'draft' || application?.status === 'changes_requested');

  const [category, setCategory] = useState<Category>(application?.category ?? 'individual');

  useEffect(() => {
    setCategory(application?.category ?? 'individual');
  }, [application?.id, application?.category]);

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Seller application temporarily unavailable"
        message="We couldn’t load your draft. Your session is still in place; try again."
      />
    );
  }

  if (!editable) {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Seller application
          </h1>
          {application?.status === 'rejected' ? (
            <>
              <p className="mt-3 leading-7 text-muted">
                Your previous application was rejected. You may start a new application.
              </p>
              <Link
                className="mt-6 inline-flex font-semibold text-forest underline"
                to="/account/seller-application/edit?new=1"
              >
                Start a new application
              </Link>
            </>
          ) : (
            <p className="mt-3 leading-7 text-muted">
              This application is read-only. View its latest status from the seller application
              page.
            </p>
          )}
          <Link
            className="mt-6 inline-flex font-semibold text-forest underline"
            to="/account/seller-application"
          >
            Back to seller application
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  const values = actionData?.values;
  const fieldValue = (name: FieldName) => values?.[name] ?? application?.[name] ?? '';

  const categoryLocked = application?.status === 'changes_requested';
  const requiredEvidence: EvidenceType[] =
    category === 'individual'
      ? ['applicant_id']
      : ['applicant_id', 'business_registration'];

  if (
    category === 'commercial' &&
    application?.proofOfAuthorityRequired &&
    !requiredEvidence.includes('proof_of_authority')
  ) {
    requiredEvidence.push('proof_of_authority');
  }

  const evidenceRevision = Math.max(
    application?.revision ?? 1,
    evidenceFetcher.data?.revision ?? 1,
  );

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          {creating ? 'Start your seller application' : 'Edit your seller application'}
        </h1>

        {actionData?.status === 'invalid' && (
          <div className="mt-6">
            <Alert>{actionData.message ?? 'Check the form and try again.'}</Alert>
          </div>
        )}
        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}
        {actionData?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many requests. Wait a little while and try again.</Alert>
          </div>
        )}
        {actionData?.status === 'conflict' && (
          <div className="mt-6">
            <Alert>An application is already open. Return to its current status.</Alert>
          </div>
        )}
        {actionData?.status === 'stale' && (
          <div className="mt-6 space-y-3">
            <Alert>
              This draft changed elsewhere. Your unsaved values are still shown. Reload the current
              draft before saving again.
            </Alert>
            <Link
              className="inline-flex font-semibold text-forest underline"
              to="/account/seller-application/edit?reload=1"
            >
              Reload current draft
            </Link>
          </div>
        )}
        {actionData?.status === 'missing' && (
          <div className="mt-6">
            <Alert>
              {`Before submitting, provide: ${actionData.missingFields?.join(', ') || 'the required application details'}.`}
            </Alert>
          </div>
        )}
        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Your draft could not be saved. Your entered values are still shown.</Alert>
          </div>
        )}

        <Form className="mt-8 space-y-5" method="post" noValidate aria-busy={isSubmitting}>
          <input name="csrfToken" type="hidden" value={page.csrfToken} />

          {creating ? (
            <input name="intent" type="hidden" value="create" />
          ) : (
            <>
              <input name="intent" type="hidden" value="update" />
              <input name="applicationId" type="hidden" value={application?.id ?? ''} />
              <input name="expectedRevision" type="hidden" value={application?.revision ?? ''} />
            </>
          )}

          {categoryLocked ? (
            <>
              <input name="category" type="hidden" value={application?.category ?? category} />
              <p className="text-sm text-muted">
                Category:{' '}
                <span className="font-semibold text-ink">
                  {application?.category === 'commercial' ? 'Commercial' : 'Individual'}
                </span>
              </p>
            </>
          ) : (
            <FormField id="category" label="Seller category">
              <select
                id="category"
                name="category"
                value={category}
                onChange={(event) => setCategory(event.currentTarget.value as Category)}
                className={inputClassName}
              >
                <option value="individual">Individual</option>
                <option value="commercial">Commercial</option>
              </select>
            </FormField>
          )}

          <FormField id="legalName" label="Applicant’s legal name">
            <input
              className={inputClassName}
              id="legalName"
              name="legalName"
              type="text"
              maxLength={200}
              defaultValue={fieldValue('legalName')}
            />
          </FormField>

          {category === 'individual' ? (
            <FormField id="sellerDisplayName" label="Seller display name">
              <input
                className={inputClassName}
                id="sellerDisplayName"
                name="sellerDisplayName"
                type="text"
                maxLength={200}
                defaultValue={fieldValue('sellerDisplayName')}
              />
            </FormField>
          ) : (
            <>
              <FormField id="registeredBusinessName" label="Registered business name">
                <input
                  className={inputClassName}
                  id="registeredBusinessName"
                  name="registeredBusinessName"
                  type="text"
                  maxLength={200}
                  defaultValue={fieldValue('registeredBusinessName')}
                />
              </FormField>
              <FormField id="businessRole" label="Your role in the business">
                <input
                  className={inputClassName}
                  id="businessRole"
                  name="businessRole"
                  type="text"
                  maxLength={120}
                  defaultValue={fieldValue('businessRole')}
                />
              </FormField>
              <FormField id="storefrontName" label="Storefront name (optional)">
                <input
                  className={inputClassName}
                  id="storefrontName"
                  name="storefrontName"
                  type="text"
                  maxLength={200}
                  defaultValue={fieldValue('storefrontName')}
                />
              </FormField>
            </>
          )}

          <FormField id="areaServed" label="Area served in Yaoundé">
            <input
              className={inputClassName}
              id="areaServed"
              name="areaServed"
              type="text"
              maxLength={120}
              defaultValue={fieldValue('areaServed')}
            />
          </FormField>

          <FormField id="contactPhone" label="Contact phone (optional)">
            <input
              className={inputClassName}
              id="contactPhone"
              name="contactPhone"
              type="tel"
              maxLength={40}
              autoComplete="tel"
              defaultValue={fieldValue('contactPhone')}
            />
          </FormField>

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Saving draft…' : creating ? 'Create draft' : 'Save draft'}
          </Button>

          <p className="sr-only" role="status" aria-live="polite">
            {isSubmitting ? 'Saving draft…' : ''}
          </p>
        </Form>

        {application && (
          <section aria-labelledby="evidence-heading" className="mt-8 space-y-5">
            <h2 className="text-xl font-semibold text-ink" id="evidence-heading">
              Required documents
            </h2>
            <p className="text-sm leading-6 text-muted">
              Upload a JPG, PNG, or PDF file up to 10 MiB. Files are stored privately.
            </p>

            {requiredEvidence.map((type) => {
              const evidence = application.evidence.find((item) => item.type === type);
              const evidenceActionMatches = evidenceFetcher.data?.type === type;
              const evidenceAction = evidenceFetcher.data;

              return (
                <div className="space-y-3 rounded-xl border border-stone-200 p-4" key={type}>
                  <div>
                    <h3 className="font-semibold text-ink">{evidenceLabels[type]}</h3>
                    <p className="text-sm text-muted">
                      {evidence
                        ? `Uploaded (${Math.ceil(evidence.byteSize / 1024)} KB)`
                        : 'Not uploaded'}
                    </p>
                  </div>

                  {evidenceActionMatches && evidenceAction?.status === 'stale' && (
                    <>
                      <Alert>
                        The draft changed before this file could be saved. Reload the application
                        before uploading again.
                      </Alert>
                      <Link
                        className="inline-flex font-semibold text-forest underline"
                        to="/account/seller-application/edit?reload=1"
                      >
                        Reload current draft
                      </Link>
                    </>
                  )}
                  {evidenceActionMatches && evidenceAction?.status === 'too-large' && (
                    <Alert>The file exceeds the 10 MiB limit. Choose a smaller file.</Alert>
                  )}
                  {evidenceActionMatches && evidenceAction?.status === 'invalid' && (
                    <Alert>Choose a non-empty JPG, PNG, or PDF file and try again.</Alert>
                  )}
                  {evidenceActionMatches && evidenceAction?.status === 'blocked' && (
                    <Alert>We couldn’t verify this upload. Refresh the page and try again.</Alert>
                  )}
                  {evidenceActionMatches && evidenceAction?.status === 'unavailable' && (
                    <Alert>The file could not be uploaded. Your existing file remains available.</Alert>
                  )}
                  {evidenceActionMatches && evidenceAction?.status === 'uploaded' && (
                    <p className="text-sm font-semibold text-forest" role="status">
                      {evidenceLabels[type]} uploaded.
                    </p>
                  )}

                  <evidenceFetcher.Form
                    action={`/account/seller-application/evidence?applicationId=${encodeURIComponent(application.id)}&type=${type}&expectedRevision=${evidenceRevision}`}
                    encType="multipart/form-data"
                    method="post"
                  >
                    <input name="csrfToken" type="hidden" value={page.csrfToken} />
                    <FormField
                      id={`evidence-${type}`}
                      label={evidence ? 'Choose a replacement file' : 'Choose a file'}
                      hint="Accepted formats: JPG, PNG, PDF. Maximum size: 10 MiB."
                    >
                      <input
                        accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                        className={inputClassName}
                        id={`evidence-${type}`}
                        name="file"
                        required
                        type="file"
                      />
                    </FormField>
                    <Button
                      className="mt-4"
                      disabled={evidenceFetcher.state !== 'idle'}
                      type="submit"
                    >
                      {evidenceFetcher.state !== 'idle'
                        ? 'Uploading…'
                        : evidence
                          ? 'Replace file'
                          : 'Upload file'}
                    </Button>
                    <p className="sr-only" role="status" aria-live="polite">
                      {evidenceFetcher.state !== 'idle' ? 'Uploading evidence…' : ''}
                    </p>
                  </evidenceFetcher.Form>
                </div>
              );
            })}
          </section>
        )}

        {application && (
          <Form className="mt-8" method="post">
            <input name="csrfToken" type="hidden" value={page.csrfToken} />
            <input name="intent" type="hidden" value="submit" />
            <input name="applicationId" type="hidden" value={application.id} />
            <input name="expectedRevision" type="hidden" value={application.revision} />
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Submitting application…' : 'Submit application'}
            </Button>
          </Form>
        )}

        <Link
          className="mt-6 inline-flex font-semibold text-forest underline"
          to="/account/seller-application"
        >
          Cancel
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
