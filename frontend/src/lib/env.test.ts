import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEnv } from "node:util";
import { NextRequest } from "next/server";
import { GET } from "../app/api/[...path]/route";

const examples = ["frontend.env.example", "frontend.prod.env.example"];
const cases = [
  { name: "unset", value: undefined, target: "http://backend:3001" },
  { name: "empty", value: "", target: "http://backend:3001" },
  { name: "configured", value: "http://custom-backend:4001", target: "http://custom-backend:4001" },
  ...examples.map((name) => ({
    name,
    value: parseEnv(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8")).BACKEND_URL,
    target: "http://backend:3001",
  })),
];

for (const { name, value, target } of cases) {
  test(`API proxy uses a working backend URL when ${name}`, async (t) => {
    const previous = process.env.BACKEND_URL;
    t.after(() => {
      if (previous === undefined) delete process.env.BACKEND_URL;
      else process.env.BACKEND_URL = previous;
    });
    if (value === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = value;

    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      calls += 1;
      assert.equal(String(input), `${target}/api/public/schedules?date=2026-11-13`);
      return Response.json({ schedules: [] });
    });
    const response = await GET(
      new NextRequest("http://localhost:3000/api/public/schedules?date=2026-11-13"),
      { params: Promise.resolve({ path: ["public", "schedules"] }) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { schedules: [] });
    assert.equal(calls, 1);
  });
}
