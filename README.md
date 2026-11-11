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

Edit `backend/.env` locally. Do not commit it. Set `DATABASE_URL` to a development database and login you control. The example uses the local filesystem adapter at `C:/tx-private/tennis-xpress/evidence`; create that directory or set `SELLER_EVIDENCE_STORAGE_DIR` to another absolute path outside the repository, public assets, and web-served directories. The backend creates private `.staging` and `objects` subdirectories and restricts file modes where the operating system supports them.

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

The catalog is shared and contains no seller ownership, offer condition, price, stock, SKU, or seller photos. The seller-listing layer should reference a catalog product and its selected catalog variant/configuration, while storing seller-specific condition, price, stock, SKU, and listing photos on the seller's listing or offer records. Listing work must enforce that a referenced variant belongs to the selected product. The listing persistence/API and its precise inventory and SKU uniqueness rules are deferred to the scheduled listing tasks; no seller-specific listing fields are part of the catalog backend.

## Guarded PostgreSQL tests and isolated evidence storage

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

The first command must print `Verified test database: tennis_xpress_app_test / tennis_xpress_app_test`. The migration script repeats the guard before applying migrations. Evidence integration suites create a unique temporary storage directory outside the repository and remove it after each suite. They use synthetic accounts and evidence; no development evidence files are used.

Backend checks from the repository root:

```bash
npm run format:check
npm run lint
npm run typecheck --workspace=@tennis-xpress/backend
npm run test --workspace=@tennis-xpress/backend
npm run test:integration --workspace=@tennis-xpress/backend
```

There is currently no separate backend `build` script: the backend runs TypeScript through `tsx`, and `typecheck` is its compile-time verification. Root `lint` covers both workspaces; run the backend unit and integration scripts above for backend tests.

## Private storage deployment note

The current evidence adapter is a private local filesystem implementation. Production object storage, such as S3-compatible storage, including bucket policy, encryption, lifecycle cleanup, and deployment credentials, is deferred deployment work. Do not expose the local evidence directory through a static file server or mount it under a public web root. Keep database connection strings, SMTP credentials, MFA keys, operator registry paths, and private evidence outside source control.
