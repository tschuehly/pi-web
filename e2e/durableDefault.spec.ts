import { expect, test } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// AC6 (pi-workbench docs/plans/pi-durable-cutover-spec.md, B6): with PI_WEB_DURABLE_DEFAULT=1 on the session daemon,
// New Chat creates a Durable Chat; without it, New Chat creates a legacy Chat. The switch is daemon environment, so the
// spec runs once per state: PI_WEB_E2E_DURABLE_DEFAULT=1 (the harness passes it on as PI_WEB_DURABLE_DEFAULT) and unset.
// Needs the Workbench Durable host: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts.
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const durableDefault = process.env["PI_WEB_E2E_DURABLE_DEFAULT"] === "1";

test(`New Chat creates a ${durableDefault ? "Durable" : "legacy"} Chat when the default switch is ${durableDefault ? "on" : "off"}`, async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get("session") ?? "";
  // Only Durable Chats list the capabilities their host names; legacy Chats support everything and list none.
  const listed = async () =>
    (
      (await (await page.request.get(`${base}api/sessions?${new URLSearchParams({ cwd: project }).toString()}`)).json()) as {
        id: string;
        capabilities?: string[];
      }[]
    ).find((s) => s.id === id);
  await expect.poll(async () => (await listed()) !== undefined).toBe(true);
  expect((await listed())?.capabilities !== undefined).toBe(durableDefault);
});
