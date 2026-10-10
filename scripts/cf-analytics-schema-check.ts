import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HUB_BUDGET_GRAPHQL_SCHEMA_CHECK_PATHS,
} from "../supabase/functions/_shared/hub-budget-metrics.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const REQUEST_TIMEOUT_MS = 10_000;

type TypeReference = {
  kind?: unknown;
  name?: unknown;
  ofType?: unknown;
};

type GraphqlField = {
  name?: unknown;
  type?: unknown;
};

type GraphqlType = {
  name?: unknown;
  kind?: unknown;
  fields?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namedTypeName(value: unknown): string | null {
  let current: unknown = value;
  while (isRecord(current) && (current.kind === "LIST" || current.kind === "NON_NULL")) {
    current = current.ofType;
  }
  return isRecord(current) && typeof current.name === "string" ? current.name : null;
}

function typeField(types: Map<string, GraphqlType>, typeName: string, fieldName: string): GraphqlField | null {
  const type = types.get(typeName);
  if (!type || !Array.isArray(type.fields)) return null;
  const field = type.fields.find((candidate): candidate is GraphqlField =>
    isRecord(candidate) && candidate.name === fieldName
  );
  return field ?? null;
}

function typeMapFromSchema(schema: unknown): {
  types: Map<string, GraphqlType>;
  queryTypeName: string | null;
} {
  if (!isRecord(schema)) return { types: new Map(), queryTypeName: null };
  const rawTypes = schema.types;
  const types = new Map<string, GraphqlType>();
  if (Array.isArray(rawTypes)) {
    for (const candidate of rawTypes) {
      if (isRecord(candidate) && typeof candidate.name === "string") {
        types.set(candidate.name, candidate as GraphqlType);
      }
    }
  }
  const queryType = schema.queryType;
  return {
    types,
    queryTypeName: isRecord(queryType) && typeof queryType.name === "string"
      ? queryType.name
      : null,
  };
}

function accountTypeName(
  types: Map<string, GraphqlType>,
  queryTypeName: string | null,
): string | null {
  if (!queryTypeName) return null;
  const viewerField = typeField(types, queryTypeName, "viewer");
  const viewerTypeName = viewerField ? namedTypeName(viewerField.type) : null;
  if (!viewerTypeName) return null;
  const accountsField = typeField(types, viewerTypeName, "accounts");
  return accountsField ? namedTypeName(accountsField.type) : null;
}

function hasFieldPath(
  types: Map<string, GraphqlType>,
  rootTypeName: string | null,
  path: readonly string[],
): boolean {
  if (!rootTypeName || path.length === 0) return false;
  let currentTypeName = rootTypeName;
  for (const segment of path) {
    const field = typeField(types, currentTypeName, segment);
    if (!field) return false;
    const nextTypeName = namedTypeName(field.type);
    if (!nextTypeName) return false;
    currentTypeName = nextTypeName;
  }
  return true;
}

export function inspectHubBudgetGraphqlSchema(schema: unknown): Array<{
  path: string;
  present: boolean;
}> {
  const { types, queryTypeName } = typeMapFromSchema(schema);
  const rootTypeName = accountTypeName(types, queryTypeName);
  return HUB_BUDGET_GRAPHQL_SCHEMA_CHECK_PATHS.map((path) => ({
    path: path.join("."),
    present: hasFieldPath(types, rootTypeName, path),
  }));
}

function introspectionQuery(accountId: string): string {
  return `query HubBudgetAnalyticsSchemaCheck {
    __schema {
      queryType { name }
      types {
        name
        kind
        fields(includeDeprecated: true) {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType { kind name }
              }
            }
          }
        }
      }
    }
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        accountTag
      }
    }
  }`;
}

async function runSchemaCheck(): Promise<void> {
  const token = process.env.SNOTE_CF_ANALYTICS_TOKEN?.trim();
  const accountId = process.env.SNOTE_CF_ACCOUNT_ID?.trim();
  if (!token || !accountId) throw new Error("Required environment is missing");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: introspectionQuery(accountId) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Schema request failed");
    const envelope: unknown = await response.json();
    if (!isRecord(envelope)) throw new Error("Invalid response");
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      throw new Error("Schema request failed");
    }
    const data = envelope.data;
    const schema = isRecord(data) ? data.__schema : null;
    const viewer = isRecord(data) ? data.viewer : null;
    const accounts = isRecord(viewer) ? viewer.accounts : null;
    if (
      !isRecord(schema)
      || !Array.isArray(accounts)
      || accounts.length !== 1
      || !isRecord(accounts[0])
      || accounts[0].accountTag !== accountId
    ) throw new Error("Schema response is unavailable");

    for (const result of inspectHubBudgetGraphqlSchema(schema)) {
      console.log(`${result.path}: ${result.present ? "có" : "thiếu"}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runSchemaCheck().catch(() => {
    console.error("Schema check failed; no credentials or analytics data were printed.");
    process.exitCode = 1;
  });
}
