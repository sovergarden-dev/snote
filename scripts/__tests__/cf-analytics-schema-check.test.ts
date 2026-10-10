// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inspectHubBudgetGraphqlSchema } from "../cf-analytics-schema-check.ts";

function reference(name: string, kind = "OBJECT") {
  return { kind: "NON_NULL", ofType: { kind, name } };
}

function listReference(name: string) {
  return {
    kind: "NON_NULL",
    ofType: { kind: "LIST", ofType: { kind: "NON_NULL", ofType: { kind: "OBJECT", name } } },
  };
}

function objectType(name: string, fields: Record<string, string>) {
  return {
    name,
    kind: "OBJECT",
    fields: Object.entries(fields).map(([fieldName, typeName]) => ({
      name: fieldName,
      type: reference(typeName),
    })),
  };
}

function schemaFixture(options: { omitPrimaryRowsWritten?: boolean; omitAlternates?: boolean } = {}) {
  const periodicSumFields = {
    activeTime: "Float",
    inboundWebsocketMsgCount: "Int",
    ...(options.omitPrimaryRowsWritten ? {} : { rowsWritten: "Int" }),
    ...(options.omitAlternates ? {} : { duration: "Int" }),
  };
  const types = [
    {
      name: "Query",
      kind: "OBJECT",
      fields: [{ name: "viewer", type: reference("Viewer") }],
    },
    {
      name: "Viewer",
      kind: "OBJECT",
      fields: [{ name: "accounts", type: listReference("Account") }],
    },
    objectType("Account", {
      workersInvocationsAdaptive: "WorkerRows",
      durableObjectsInvocationsAdaptiveGroups: "DoInvocationRows",
      durableObjectsPeriodicGroups: "PeriodicRows",
      ...(options.omitAlternates ? {} : { durableObjectsSqlStorageGroups: "SqlStorageRows" }),
    }),
    objectType("WorkerRows", { sum: "WorkerSum", dimensions: "WorkerDimensions" }),
    objectType("WorkerSum", { requests: "Int" }),
    objectType("WorkerDimensions", { scriptName: "String", datetimeMinute: "DateTime" }),
    objectType("DoInvocationRows", { sum: "DoInvocationSum" }),
    objectType("DoInvocationSum", { requests: "Int" }),
    objectType("PeriodicRows", { sum: "PeriodicSum" }),
    objectType("PeriodicSum", periodicSumFields),
    objectType("SqlStorageRows", { sum: "SqlStorageSum" }),
    objectType("SqlStorageSum", options.omitAlternates ? {} : { rowsWritten: "Int" }),
    { name: "Int", kind: "SCALAR", fields: null },
    { name: "Float", kind: "SCALAR", fields: null },
    { name: "String", kind: "SCALAR", fields: null },
    { name: "DateTime", kind: "SCALAR", fields: null },
  ];
  return { queryType: { name: "Query" }, types };
}

describe("Cloudflare Analytics schema checker", () => {
  it("reports every primary and alternative field present in the schema fixture", () => {
    const result = inspectHubBudgetGraphqlSchema(schemaFixture());
    expect(result).toHaveLength(9);
    expect(result.every((field) => field.present)).toBe(true);
    expect(result.map((field) => field.path)).toContain(
      "durableObjectsPeriodicGroups.sum.rowsWritten",
    );
    expect(result.map((field) => field.path)).toContain(
      "durableObjectsSqlStorageGroups.sum.rowsWritten",
    );
    expect(result.map((field) => field.path)).toContain(
      "durableObjectsPeriodicGroups.sum.duration",
    );
  });

  it("reports unsupported SQLite candidates as missing without suppressing other fields", () => {
    const result = inspectHubBudgetGraphqlSchema(schemaFixture({
      omitPrimaryRowsWritten: true,
      omitAlternates: true,
    }));
    expect(result.filter((field) => !field.present).map((field) => field.path)).toEqual([
      "durableObjectsPeriodicGroups.sum.rowsWritten",
      "durableObjectsSqlStorageGroups.sum.rowsWritten",
      "durableObjectsPeriodicGroups.sum.duration",
    ]);
  });
});
