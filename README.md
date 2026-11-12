# Tennis Xpress

Tennis Xpress is a lawn tennis equipment marketplace launching in Yaoundé, Cameroon. Buyers and sellers share an account; Seller access is granted only after an administrator approves an application. The backend is a Fastify REST API under `/api/v1`, with PostgreSQL persistence managed by Drizzle.

## Backend setup from a clean checkout

The repository pins Node.js `24.22.2` and npm `11.19.1`. Install from the repository root so npm uses the workspace lockfile:

```bash
node --version
npm --version
npm ci
cp backend/.env.example backend/.env
```

Edit `backend/.env` locally. Do not commit it. Set `DATABASE_URL` to a development database and login you control. `SELLER_EVIDENCE_STORAGE_DIR` and `SELLER_LISTING_IMAGE_STORAGE_DIR` select separate private local directories; the example uses `C:/tx-private/tennis-xpress/evidence` and `C:/tx-private/tennis-xpress/listing-images`. Keep both outside the repository, public assets, and web-served directories. The backend creates private `.staging` and `objects` subdirectories and restricts file modes where the operating system supports them. The listing-image setting defaults to `C:/tx-private/tennis-xpress/listing-images` if omitted.

For a local PostgreSQL instance, create a development role and database using an administrative PostgreSQL account. Replace the password placeholder with a local password; URL-encode special characters in connection URLs.

```sql
CREATE ROLE tennis_xpress_app_dev LOGIN PASSWORD 'REPLACE_WITH_LOCAL_PASSWORD';
CREATE DATABASE tennis_xpress_app_dev OWNER tennis_xpress_app_dev;
```

From the repository root, apply development migrations and check the connection:

```bash
npm run db:migrate:dev --workspace=@tennis-xpress/backend
npm run db:check --workspace=@tennis-xpress/backend
```

Expected results: Drizzle reports applied or already-applied migrations, and the connection check returns `{ connected: 1 }`. Start the backend in one terminal:

```bash
npm run dev --workspace=@tennis-xpress/backend
```

The API listens at `http://127.0.0.1:3000` by default. Swagger UI is available at `http://127.0.0.1:3000/docs` when `NODE_ENV` is not `production`. The OpenAPI document is generated from the Fastify route schemas; there is no separately maintained static OpenAPI file.

To run the frontend, copy `frontend/.env.example` to `frontend/.env`, set its backend API origin to `http://127.0.0.1:3000`, and start it from the repository root:

```bash
cp frontend/.env.example frontend/.env
npm run dev --workspace=@tennis-xpress/frontend
```

Use `http://127.0.0.1:5173` consistently for local signup and CSRF origin checks. For development verification and password recovery email, configure a Mailtrap Email Sandbox account in the untracked `backend/.env`: set `EMAIL_ENABLED=true` and provide the sandbox SMTP host, port, username, password, and sender. Keep real credentials out of source control. When SMTP is disabled, account emails are suppressed; use the fake sender in tests instead of expecting delivery.

## Seller onboarding behavior

An account must be active and have a verified email to create an application. Each account may have one open application across `draft`, `submitted`, and `changes_requested`. `approved` and `rejected` are closed outcomes. An approved account cannot start another onboarding cycle; a rejected account may apply again. The applicant email used for review notices is the account's verified address, not an editable application field.

Application states are:

- `draft`: editable; applicant can save fields and upload or replace evidence.
- `submitted`: read-only for the applicant and available to eligible administrators for review.
- `changes_requested`: editable again; reviewer feedback and requested evidence are returned to the applicant.
- `approved`: closed application; approval and active Seller operating access are written in one transaction.
- `rejected`: closed application with applicant-facing feedback; an eligible account may create a new application.

Every draft edit, evidence replacement, submission, and review decision uses the revision returned by the latest response. A stale revision or an invalid state transition returns a conflict; clients should reload the current application and let the applicant resolve the conflict rather than silently overwrite newer data. The first successful submission locks the category for later resubmission.

Individual applications require legal name, seller display name, area served in Yaoundé, and applicant photo ID. Commercial applications require registered business name, applicant legal name and business role, area served in Yaoundé, applicant photo ID, and business registration evidence. Contact phone is optional; Commercial storefront name is optional. Proof of authority is required on resubmission only when an administrator explicitly requested it. Text fields are shape-validated and area served is a free-text value (the API does not currently enforce an approved Yaoundé neighborhood list).

The draft JSON fields are `category`, `legalName` (max 200 characters), `sellerDisplayName` (max 200), `areaServed` (max 120), `contactPhone` (max 40), `registeredBusinessName` (max 200), `businessRole` (max 120), and `storefrontName` (max 200). Supplied nullable fields may be `null`; category-incompatible fields and all unknown properties are rejected. For example:

```json
{
  "category": "individual",
  "legalName": "Synthetic Applicant",
  "sellerDisplayName": "Court Side Gear",
  "areaServed": "Yaounde"
}
```

Applicant application responses use `{ "data": { "application": ... } }`. The application contains `id`, `category`, `status`, `revision`, those applicant fields (null when unset), `proofOfAuthorityRequired`, safe `evidence[]` summaries, latest `review` decision/feedback/requested-evidence data or null, and `createdAt`/`updatedAt`. The response does not contain the account's email, storage key, or local path.

Evidence accepts JPEG, PNG, or PDF up to 10 MiB (10,485,760 bytes) per file. Supported types are `applicant_id` for either category and `business_registration` and `proof_of_authority` for Commercial applications. Uploads are streamed to private staging, checked for size and detected media type, promoted to private object storage, and then committed with metadata and a revision check. The prior file remains usable until replacement succeeds. API responses expose only evidence type, media type, size, and update timestamp; storage keys and filesystem paths are never returned. Old staging files and unreferenced objects are cleaned after a 24-hour grace period at backend startup.

## Seller onboarding API

All JSON success responses use a `{ "data": ... }` envelope. Errors use `{ "error": { "code", "message", "details?" }, "requestId" }`. The server derives the applicant from the authenticated session; clients cannot choose an owner ID. Foreign and unknown application IDs share a generic 404 on applicant routes. Authenticated endpoints are non-cacheable where they return private application data.

| Method and path                                                            | Purpose and contract                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/me/seller-applications`                                      | Create an incomplete draft. JSON body includes `category` with value `individual` or `commercial`, plus optional application fields. Returns 201 `{data:{application}}`. A second open application or an account with an approved application returns a conflict.                                                                                                                            |
| `GET /api/v1/me/seller-applications/current`                               | Return `{data:{application}}`; application is the latest applicant-facing record or `null`. Includes current status, revision, safe evidence summaries, latest review feedback/requested evidence, and timestamps.                                                                                                                                                                           |
| `PATCH /api/v1/me/seller-applications/:id`                                 | Update only allowed application fields while Draft or Changes requested. Body requires `expectedRevision` and at least one editable field. Unknown fields are rejected. Returns the updated application and revision.                                                                                                                                                                        |
| `PUT /api/v1/me/seller-applications/:id/evidence/:type?expectedRevision=N` | Upload/replace one multipart `file` with one of the supported evidence types. Returns safe evidence metadata and the new application revision. Oversize files return 413, unsupported content returns validation error, and stale revisions return conflict.                                                                                                                                 |
| `GET /api/v1/me/seller-applications/:id/evidence/:type`                    | Download evidence for an owned application. Returns private, non-cacheable bytes with a safe attachment name.                                                                                                                                                                                                                                                                                |
| `POST /api/v1/me/seller-applications/:id/submit`                           | Submit a complete Draft or Changes requested application. JSON body: `{ "expectedRevision": N }`. Returns the updated application. Validation errors identify missing fields/documents; stale, duplicate, or disallowed-state submissions conflict.                                                                                                                                          |
| `GET /api/v1/admin/seller-applications?limit=25&offset=0`                  | Bounded review queue (limit 1–100, offset ≥0). Requires current administrator permission and valid MFA elevation. The reviewer’s own application is excluded.                                                                                                                                                                                                                                |
| `GET /api/v1/admin/seller-applications/:id`                                | Get a submitted application and the submitted revision seen by the reviewer. Requires administrator permission and valid session MFA; self-review and unknown/non-submitted applications are denied as not found.                                                                                                                                                                            |
| `GET /api/v1/admin/seller-applications/:id/evidence/:type`                 | Download evidence for an eligible submitted application. Rechecks administrator permission and MFA on each request; denies self-review.                                                                                                                                                                                                                                                      |
| `POST /api/v1/admin/seller-applications/:id/decision`                      | Decide the exact revision using JSON fields `expectedRevision`, `decision` (`approve`, `request_changes`, or `reject`), optional `feedback`, and optional `requestedEvidence`. Feedback is required for Request changes and Reject. Requested evidence is only valid for Request changes; Commercial proof of authority can be requested. Stale, duplicate, or competing decisions conflict. |
| `GET /api/v1/me/workspaces`                                                | Return current Buyer/Seller/Admin navigation availability. Seller availability is derived from both approved application status and a matching active operating-access record.                                                                                                                                                                                                               |

An applicant update body contains `expectedRevision` plus one or more allowed fields, for example `{"expectedRevision":3,"legalName":"Synthetic Applicant"}`. Evidence uploads use multipart form data with exactly one `file` part; the type is in the URL and the expected revision is a required query parameter. Submission uses `{"expectedRevision":N}`. Review decisions use JSON such as `{"expectedRevision":N,"decision":"request_changes","feedback":"Please provide proof of authority.","requestedEvidence":["proof_of_authority"]}`. The decision response returns application ID, reviewed revision, decision, feedback, requested evidence, decision time, new application status, and new revision.

Review decisions are recorded once per submitted revision. Approve updates the application and creates active Seller operating access in the same transaction. Request changes and Reject update the applicant-visible status, feedback, and requested evidence. Admin routes enforce current permission and session MFA independently of frontend navigation. Seller access is checked from current application and operating-access records on every protected request; missing, restricted, inactive, or inconsistent access denies Seller while an otherwise eligible Buyer account remains available.

## Catalog backend

Catalog categories, brands, products, and variants are shared catalog records. Seller-specific offer information is not stored on these records. Product attributes describe the catalog item; a variant represents one selectable configuration of that item.

### Launch data and local setup

The launch loader inserts Tennis racquets, Tennis balls, Racquet strings, Grips and overgrips, Tennis shoes, Tennis bags, and Racquet accessories, plus the eleven brands Wilson, HEAD, Babolat, Yonex, Dunlop, Tecnifibre, Prince, Artengo, ASICS, adidas, and Nike. It inserts by stable slug and does not overwrite an existing row on rerun, so administrator-edited names, image URLs, active state, slugs, and IDs are preserved. Unbranded is not a brand row: a product selects it with `brandId: null`.

After applying migrations to a local development database, load launch records from the repository root:

```bash
npm run db:migrate:dev --workspace=@tennis-xpress/backend
npm run db:seed:catalog --workspace=@tennis-xpress/backend
```

For the guarded test database, verify the target first, apply migrations if needed, then load its launch records:

```bash
npm run db:verify:test --workspace=@tennis-xpress/backend
npm run db:migrate:test --workspace=@tennis-xpress/backend
npm run db:seed:catalog:test --workspace=@tennis-xpress/backend
```

The test database guard must report `tennis_xpress_app_test / tennis_xpress_app_test`. Do not use the development or a production database for integration tests. To check the launch data, use `npm run test:integration --workspace=@tennis-xpress/backend -- tests/integration/modules/catalog/catalog-reference-data.integration.test.ts`; it verifies the exact seven category and eleven brand slugs and tests that reruns preserve administrator edits.

### Attribute rules and product configurations

Category attribute rules are code-defined and returned with active category choices. Each rule exposes a stable key, label, data type, whether it is required, allowed values and units where applicable, numeric or length limits, variation eligibility, and conditional requirements. `variantAllowed` means a field is eligible to vary for that category; a product selects its actual variant options separately through `variantOptionKeys`.

The shared color options are `black`, `white`, `red`, `blue`, `green`, `yellow`, `orange`, `pink`, `purple`, `gray`, `brown`, `multicolor`, and `other`. Racquet length is at least 1 inch; head size uses square inches and unstrung weight uses grams. String thickness uses millimetres and string length uses metres (minimum 1 metre). Shoe EU sizes range from 30 to 50 in 0.5 increments. Grip thickness is 0.5–5 mm; bag dimensions are positive centimetres for height, length, and width. Tennis-ball pack count and accessory/grip piece count range from 1 to 100. The API’s category `attributeRules` response is the authoritative machine-readable source for each field’s constraints.

| Category            | Required fixed or configured fields                                                                                                                                                               | Optional fields and selectable variant options                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Tennis racquets     | `audience` (`adult` or `junior`), `lengthInches` (inches); adult racquets also require `gripSize` (`L0`–`L5`)                                                                                     | `headSizeSquareInches`, `unstrungWeightGrams`, `stringPattern`; `gripSize` may vary                      |
| Tennis balls        | `typeOrStage` (`standard`, `red`, `orange`, `green`), `pressurization` (`pressurized`, `pressureless`), `ballsPerPack` (1–100)                                                                    | `intendedCourtSurface` (`hard_court`, `clay_court`, `grass_court`, `all_court`); `ballsPerPack` may vary |
| Racquet strings     | `material` (`natural_gut`, `multifilament`, `nylon`, `polyester`, `hybrid`, `other`), `thicknessMm` (one of 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4), `format` (`set`, `reel`), `lengthMetres` | `color`; `thicknessMm` may vary                                                                          |
| Grips and overgrips | `gripType` (`replacement_grip`, `overgrip`), `piecesPerPack` (1–100)                                                                                                                              | `color`, `thicknessMm` (0.5–5); `color` and `piecesPerPack` may vary                                     |
| Tennis shoes        | `euSize` (EU 30–50 in 0.5 increments), `courtSurface` (`hard_court`, `clay_court`, `all_court`)                                                                                                   | `width` (`narrow`, `regular`, `wide`, `extra_wide`), `color`; `euSize` and `color` may vary              |
| Tennis bags         | `bagType` (`backpack`, `thermobag`, `duffel`, `tote`, `other`), `racquetCapacity` (0–15)                                                                                                          | `color`, positive `dimensionsCm` (`height`, `length`, `width`); `color` and `racquetCapacity` may vary   |
| Racquet accessories | `accessoryType`, `piecesPerPack` (1–100); `compatibleRacquetModels` is required for `grommet_set`, `bumper_guard`, and `model_specific_other`                                                     | `color`; `color` and `piecesPerPack` may vary                                                            |

The validator accepts a variation-eligible field as a fixed product attribute when it is not selected in `variantOptionKeys`. When selected, every submitted variant must provide a valid value, and the field cannot also be fixed. Duplicate option combinations are rejected regardless of input key order. A product with no selected options gets exactly one default variant with empty `optionValues`; products with options require at least one configuration. Product and initial variant writes are transactional.

### Catalog API

Swagger UI at `http://127.0.0.1:3000/docs` is generated from the Fastify route schemas. These routes use the standard `{ "data": ... }` success envelope. Public reads are unauthenticated; Admin catalog reads and writes all require current administrator permission and valid MFA elevation on the current session.

| Method and path                                                                          | Access and behavior                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/catalog/categories`                                                         | Public list of active categories, each with `id`, `slug`, `name`, nullable `imageUrl`, `attributeRuleSetKey`, and the applicable attribute rules.                                                            |
| `GET /api/v1/catalog/brands`                                                             | Public list of active brands with `id`, `slug`, `name`, and nullable `imageUrl`. Unbranded is represented as a null product brand.                                                                           |
| `GET /api/v1/catalog/products?limit=25&offset=0&categoryId=<uuid>&brandId=<uuid>`        | Public page of visible products. `limit` is 1–100 (default 25), `offset` is nonnegative (default 0), and category and brand filters are optional. Results are deterministically ordered.                     |
| `GET /api/v1/catalog/products/:id`                                                       | Public detail for a visible product and its configurations. Hidden and unknown IDs return the same generic 404.                                                                                              |
| `GET /api/v1/admin/catalog/categories` and `GET /api/v1/admin/catalog/categories/:id`    | Admin list and detail, including inactive categories. List pagination is bounded to 1–100.                                                                                                                   |
| `POST /api/v1/admin/catalog/categories` and `PATCH /api/v1/admin/catalog/categories/:id` | Admin create or update. Creation sets stable `slug` and `attributeRuleSetKey`; updates can rename, set/replace/clear `imageUrl`, or change `isActive`. Slug and rule-set key remain stable after creation.   |
| `GET /api/v1/admin/catalog/brands` and `GET /api/v1/admin/catalog/brands/:id`            | Admin list and detail, including inactive brands. List pagination is bounded to 1–100.                                                                                                                       |
| `POST /api/v1/admin/catalog/brands` and `PATCH /api/v1/admin/catalog/brands/:id`         | Admin create or update. Creation sets stable `slug`; updates can rename, set/replace/clear `imageUrl`, or change `isActive`. Slug remains stable after creation.                                             |
| `GET /api/v1/admin/catalog/products` and `GET /api/v1/admin/catalog/products/:id`        | Admin list and detail, including products hidden from public reads. List pagination is bounded to 1–100.                                                                                                     |
| `POST /api/v1/admin/catalog/products` and `PATCH /api/v1/admin/catalog/products/:id`     | Admin create or update product name, description, category, brand, `isVisible`, fixed attributes, selected variant option keys, and configurations. A create explicitly sends `brandId` as a UUID or `null`. |

Category and brand `imageUrl` is URL metadata: it accepts an HTTPS URL or `null`; omitting it in a PATCH preserves the current value. Public references include the stored image URL or null. Deactivation removes categories and brands from active choice lists and new product assignments but preserves their existing product references. A product can retain an inactive reference during an unrelated update. Products default to hidden (`isVisible: false`); Admins must explicitly make a product visible before it appears in public list or detail reads. The public product representation does not expose `isVisible`, internal option-combination signatures, or persistence timestamps.

Example product creation for an Unbranded adult racquet with a fixed grip size:

```json
{
  "categoryId": "REPLACE_WITH_TENNIS_RACQUETS_CATEGORY_UUID",
  "brandId": null,
  "name": "Synthetic Adult Racquet",
  "description": "Synthetic catalog example",
  "isVisible": true,
  "fixedAttributes": {
    "audience": "adult",
    "lengthInches": 27,
    "gripSize": "L2"
  }
}
```

When `variantOptionKeys` and `variants` are supplied, each variant contains only its selected option values, for example `"variantOptionKeys":["euSize"]` with `"variants":[{"optionValues":{"euSize":42}},{"optionValues":{"euSize":42.5}}]`. The public product response contains the selected option keys and stable variant IDs, but not internal combination keys.

### Handoff to seller listings

The catalog remains shared and contains no seller ownership, condition, price, stock, SKU, or seller photos. The implemented seller-listing module references catalog products and configurations, then stores seller-specific content and offers separately. Section 9 moderation/publication and public listing discovery remain future work; details are in [Seller product-management backend](#seller-product-management-backend).

## Seller product-management backend

The backend listing module is `backend/src/modules/listings/`. `listing.routes.ts` registers authenticated Seller endpoints and their Fastify/OpenAPI schemas; `listing.schema.ts` defines request and response contracts. `listing.service.ts` and `listing.validation.ts` coordinate drafts and field rules; `listing-completeness.ts` evaluates readiness; `listing-submission.service.ts` seals immutable submissions; `listing-workflow.service.ts` creates replacement/correction drafts and returns review history; `listing-variant.service.ts` handles immediate offer operations; `listing-control.service.ts` handles pause/archive controls; and `listing-availability.ts` is a pure visibility/orderability policy for later consumers. Drizzle tables live in `listing.table.ts` and `listing-image.table.ts`. Private photo bytes are managed by `private-listing-image-file-store.ts` and listing image services. Integration tests use synthetic catalog products/accounts and temporary storage.

The module uses the catalog for product/configuration identity and the identity workspace guard for current Seller eligibility. Seller identity and ownership come from the authenticated session. Foreign and unknown listing or image IDs use the same generic not-found response. Success responses use `{ "data": ... }`; errors use `{ "error": { "code", "message", "details?" }, "requestId" }`. Stale versions and invalid state transitions return 409. Invalid fields return 400, access failures return 401/403, and an oversized streamed photo returns 413. Authenticated listing and image responses are private and non-cacheable.

### Listing lifecycle and concurrency

`POST /api/v1/seller/listings` creates an incomplete draft for a catalog product. `GET /api/v1/seller/listings` returns the authenticated seller's deterministic page (`limit` 1–100, default 25; nonnegative `offset`, default 0); `GET /api/v1/seller/listings/:id` returns owned details, pending-submission information, and the latest applicant-facing review outcome. `PATCH /api/v1/seller/listings/:id/draft` edits a draft with `expectedDraftRevision`. Drafts accept title (up to 120 characters), description (up to 5,000 characters), condition (`new`, `like_new`, `good`, `fair`), selected product configurations, and may remain incomplete. A selected catalog configuration must belong to the selected product. When no configuration is supplied, a product with exactly one catalog configuration uses that default.

`GET /api/v1/seller/listings/:id/readiness` checks current draft fields, catalog references, sellable offers, and image assignments without mutating state. It returns a deterministic list of actionable issues. `POST /api/v1/seller/listings/:id/submit` requires `{ "expectedDraftRevision": N }`, reruns readiness against current data, and atomically seals that exact draft into an immutable submitted revision. The snapshot captures descriptive content, catalog product/configuration descriptions and options, offers, and image ordering/cover/variant assignments. Incomplete, stale, repeated, or conflicting submissions do not create partial revisions.

An approved revision is selected separately by an approved-revision pointer. Editing or submitting a replacement never changes that pointer or published content. `POST /api/v1/seller/listings/:id/draft` copies either the current approved revision (`sourceApprovedRevisionId`) or an eligible reviewed revision (`sourceRevisionId`) into a new draft; both forms require `expectedControlRevision`. Only one draft or pending submission exists per listing. Changes-requested and rejected revisions remain immutable history with feedback; sellers correct them in a new draft and resubmit. Section 9 decision endpoints do not exist yet, so tests use guarded PostgreSQL fixtures for approved pointers and review outcomes.

The API has three independent concurrency tokens: `expectedDraftRevision` for draft/image edits and submission; `expectedVersion` for an individual sellable variant; and `expectedControlRevision` for replacement-draft creation and pause/resume/archive/restore. A stale token returns 409; callers must reload and resolve the conflict instead of overwriting newer data. Variant IDs remain stable for unchanged catalog configurations. A variant cannot be repointed to a different configuration, and configurations referenced by listings are protected from deletion.

### Operational offers, controls, and availability

`PATCH /api/v1/seller/listings/:id/variants/:variantId` accepts one or more of `priceXaf`, `stockQuantity`, `sku`, and `isOfferedForSale`, plus `expectedVersion`. Price is a positive whole-number XAF amount or `null` while incomplete; an offer cannot be enabled without a price. Stock is a nonnegative whole number and cannot be lowered below reserved units. SKUs are trimmed, uppercased, and unique within a seller account; omitted SKUs are generated from the stable sellable-variant ID. Price changes are recorded in price history. A configuration absent from the currently approved revision cannot be offered, even if it appears in a pending replacement.

`POST /api/v1/seller/listings/:id/pause`, `/resume`, `/archive`, and `/restore` each require `{ "expectedControlRevision": N }`. Pause/resume alter the seller pause flag only. Archive sets a reversible timestamp; it does not delete data, cancel a pending submission, or remove its draft. Restore clears the archive timestamp but preserves an existing pause and cannot clear an administrator-removal flag or bypass the Seller access guard. Duplicate or disallowed actions conflict.

`evaluateListingAvailability` in `listing-availability.ts` derives visibility and orderability from current Seller eligibility, administrator removal, archive/pause state, the approved revision's offer set, and current operational variants. An eligible approved listing can remain visible with zero stock; a paused listing remains visible but is not orderable. A stopped approved variant can remain represented but is not orderable. Orderable stock is on-hand minus reserved stock and must be positive; price must be valid and the variant must match the approved configuration. Archived, administrator-removed, seller-ineligible, and unapproved listings are hidden. This is a reusable policy, not a public catalog endpoint; future ordering must recheck authoritative state.

### Listing images and local storage

`POST /api/v1/seller/listings/:id/images?expectedDraftRevision=N` accepts one multipart `file`. Supported detected formats are JPEG, PNG, and WebP. The raw upload and normalized result are each limited to 8 MiB; each image side must be 320–8,000 pixels and the total must not exceed 40 million pixels. A listing can have at most 10 images. Limits are enforced during streaming and after image decoding/normalization. Invalid or truncated content is rejected without exposing paths or keys.

`PATCH /api/v1/seller/listings/:id/images` replaces draft assignments with an `expectedDraftRevision` and `assignments` containing `imageId`, nullable `variantId`, `sortOrder`, and `isCover`. `variantId: null` marks a common image; a non-null ID assigns the image to that listing's sellable variant. An image may be assigned to multiple variants. Consumers use a variant's assigned images when present and otherwise fall back to common images. `DELETE /api/v1/seller/listings/:id/images/:imageId?expectedDraftRevision=N` removes the image from the editable draft, not from immutable revisions. `GET /api/v1/seller/listings/:id/images` returns safe draft metadata; `GET /api/v1/seller/listings/:id/images/:imageId` returns private bytes to the owning eligible seller with `private, no-store` caching and `nosniff`.

Each upload gets a generated server-side key and immutable normalized contents; client filenames are not used as keys. Responses include only safe metadata such as image ID, media type, byte size, dimensions, and assignments. Staging and unreferenced objects older than 24 hours are eligible for cleanup at backend startup. Cleanup rechecks draft/revision references under database locks before deleting metadata or files; files referenced by submitted or approved snapshots remain. Development uses the local filesystem adapter under `SELLER_LISTING_IMAGE_STORAGE_DIR`; integration suites use isolated temporary directories. Production S3-compatible/object storage, bucket policies, encryption, durable backups, and deployed lifecycle monitoring are not implemented.

The reviewer-side `getListingImageForAuthorizedReader` helper can resolve an image assigned to an exact revision after a caller authorizes the reader. There is no Admin reviewer image route or public listing/image delivery route yet. Section 9 must authorize a reviewer against the exact submitted revision; public delivery must use only the currently approved revision and its image assignments.

### Listing API and generated OpenAPI

The canonical API schemas are attached to the Fastify routes in `listing.routes.ts` and `listing.schema.ts`; Swagger UI at `http://127.0.0.1:3000/docs` and its OpenAPI document are generated from those schemas. There is no separate static OpenAPI file. The primary request bodies and version fields are summarized below; schemas remain authoritative for all response fields and status codes.

| Method and path                                                              | Request/version                                               | Behavior                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /api/v1/seller/listings`                                               | JSON draft fields, including `catalogProductId`               | Create incomplete draft; returns 201.                                 |
| `GET /api/v1/seller/listings?limit=25&offset=0`                              | Bounded page                                                  | List only the authenticated seller's listings.                        |
| `GET /api/v1/seller/listings/:id`                                            | —                                                             | Owned detail, pending submission and latest review feedback.          |
| `PATCH /api/v1/seller/listings/:id/draft`                                    | JSON `expectedDraftRevision` plus editable fields             | Update the current draft.                                             |
| `POST /api/v1/seller/listings/:id/draft`                                     | `expectedControlRevision` plus exactly one source revision ID | Copy the approved or eligible reviewed revision into a new draft.     |
| `GET /api/v1/seller/listings/:id/readiness`                                  | —                                                             | Return current completeness issues without mutation.                  |
| `POST /api/v1/seller/listings/:id/submit`                                    | JSON `expectedDraftRevision`                                  | Validate and seal an immutable submission.                            |
| `PATCH /api/v1/seller/listings/:id/variants/:variantId`                      | JSON `expectedVersion` plus operational fields                | Update one owned sellable offer.                                      |
| `POST /api/v1/seller/listings/:id/pause`, `/resume`, `/archive`, `/restore`  | JSON `expectedControlRevision`                                | Apply one versioned seller control.                                   |
| `POST /api/v1/seller/listings/:id/images?expectedDraftRevision=N`            | Multipart single `file`                                       | Upload and attach a private image.                                    |
| `PATCH /api/v1/seller/listings/:id/images`                                   | JSON `expectedDraftRevision`, complete `assignments[]`        | Replace order, cover, common/variant image assignments.               |
| `DELETE /api/v1/seller/listings/:id/images/:imageId?expectedDraftRevision=N` | Query revision                                                | Remove image from the current draft.                                  |
| `GET /api/v1/seller/listings/:id/images[/:imageId]`                          | —                                                             | Read safe draft metadata or private image bytes for an owned listing. |

### Reproduce listing verification on Windows 11

Run these commands from Git Bash at the repository root. Copy `backend/.env.example` to the untracked `backend/.env`; set `DATABASE_URL` for local development and `TEST_DATABASE_URL` only for the guarded local test database. The sample `SELLER_LISTING_IMAGE_STORAGE_DIR` is already used by the backend; set it only if the default private path is unsuitable. Do not put image storage under `backend/public`, frontend assets, or the repository.

```bash
cp backend/.env.example backend/.env
npm run db:verify:test --workspace=@tennis-xpress/backend
npm run db:migrate:test --workspace=@tennis-xpress/backend
npm run test --workspace=@tennis-xpress/backend -- tests/unit/modules/listings
npm run test:integration --workspace=@tennis-xpress/backend -- tests/integration/modules/listings
npm run typecheck --workspace=@tennis-xpress/backend
npm exec -- eslint backend
npm exec -- prettier --check README.md backend/src/modules/listings backend/tests/unit/modules/listings backend/tests/integration/modules/listings
```

The test guard must print `Verified test database: tennis_xpress_app_test / tennis_xpress_app_test` before the migration/test commands; it rejects non-local hosts, wrong database names, or mismatched logins. The migration command repeats the check. Integration tests create synthetic users/catalog records and isolated temporary image directories. Review states and approved pointers are fixture-backed because Section 9 moderation endpoints are not implemented. On PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`; the commands above assume Git Bash.

Task 8.9 verification on 2026-11-12: all 15 backend unit test files (139 tests) and all 26 integration files (206 tests) passed; backend typecheck, ESLint, and the Section 8 Prettier check passed. There is no backend `build` script and `tsconfig.base.json` sets `noEmit: true`; `typecheck` is the available compile-time check. Swagger uses the route schemas; no static OpenAPI file or public listing API was verified or added here.

### Section 9 moderation/publication handoff

Section 9 must review the exact immutable row in `seller_listing_revisions` and its captured configuration, offer, and image-assignment rows. The submitted revision ID and revision number are returned by submission and surfaced in seller detail as `pendingSubmission`; reviewers must not reconstruct content from the mutable draft or current operational offers. Store each outcome in `seller_listing_review_outcomes` keyed to that submitted revision, including reviewer, decision, feedback, and timestamp; do not update the revision snapshot.

Approval must transactionally update `seller_listings.status` and `seller_listing_approved_revisions.revision_id` to the exact reviewed revision. Request-changes and rejection must preserve the outcome and snapshot; the existing `POST /:id/draft` accepts the eligible reviewed revision and copies its content and image assignments for correction. Current operational price/stock/SKU/offer state remains separate from these reviewed content snapshots.

Public listing discovery is not implemented. Future listing reads/order operations should consume `evaluateListingAvailability` with current seller access, removal/archive/pause flags, the approved pointer's offer set, and current variant operations; ordering must re-evaluate those facts at operation time. `getListingImageForAuthorizedReader` already supports exact-revision image reference checks after authorization. Section 9 must add the reviewer authorization/MFA route and only publish approved-revision image assignments; draft and pending images must remain private. Administrator moderation/removal endpoints, public listing/image routes, object-storage deployment, and frontend seller UI remain deferred.

## Guarded PostgreSQL tests and isolated private storage

Integration tests must only target the local database `tennis_xpress_app_test` with the matching `tennis_xpress_app_test` login. The guard rejects other hosts, databases, and usernames before test setup or cleanup. Provision the dedicated test role/database with a local PostgreSQL administrator (do not reuse production or development credentials):

```sql
CREATE ROLE tennis_xpress_app_test LOGIN PASSWORD 'REPLACE_WITH_TEST_PASSWORD';
CREATE DATABASE tennis_xpress_app_test OWNER tennis_xpress_app_test;
```

Set `TEST_DATABASE_URL` in the untracked `backend/.env` to that local target. From the repository root, verify its identity before migration or integration tests, then apply the guarded migrations:

```bash
npm run db:verify:test --workspace=@tennis-xpress/backend
npm run db:migrate:test --workspace=@tennis-xpress/backend
```

The first command must print `Verified test database: tennis_xpress_app_test / tennis_xpress_app_test`. The migration script repeats the guard before applying migrations. Evidence and listing-image integration suites create unique temporary storage directories outside the repository and remove them after each suite. They use synthetic accounts and files; no development documents or photos are used.

Backend checks from the repository root:

```bash
npm exec -- prettier --check README.md backend/src/modules/listings backend/tests/unit/modules/listings backend/tests/integration/modules/listings
npm run lint
npm run typecheck --workspace=@tennis-xpress/backend
npm run test --workspace=@tennis-xpress/backend
npm run test:integration --workspace=@tennis-xpress/backend
```

There is currently no separate backend `build` script: the backend runs TypeScript through `tsx`, and `typecheck` is its compile-time verification. Root `lint` covers both workspaces; run the backend unit and integration scripts above for backend tests.

## Private storage deployment note

The current evidence and listing-image adapters are private local filesystem implementations. Production object storage, such as S3-compatible storage, including bucket policy, encryption, lifecycle cleanup/monitoring, backup and restore, and deployment credentials, is deferred deployment work. Do not expose either local storage directory through a static file server or mount it under a public web root. Keep database connection strings, SMTP credentials, MFA keys, operator registry paths, evidence, and private photos outside source control.
