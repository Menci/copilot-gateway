import { assertFalse, assertStringIncludes } from "@std/assert";
import { DashboardPage } from "./dashboard.tsx";

Deno.test("DashboardPage renders split dashboard shell", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, 'x-data="dashboardApp()"');
  assertStringIncludes(html, "Copilot Gateway");
  assertStringIncludes(html, "API Keys");
  assertStringIncludes(html, "Total Tokens");
  assertStringIncludes(html, "Cache Hit Rate");
  assertStringIncludes(html, "function dashboardApp()");
});

Deno.test("DashboardPage renders the search section below the usage cards without architecture labels", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "Search Provider");
  assertStringIncludes(html, "Tavily");
  assertStringIncludes(html, "Microsoft Grounding");
  assertStringIncludes(html, "Save Search Config");
  assertStringIncludes(html, "Test Search");
  assertStringIncludes(
    html,
    ":disabled=\"!searchConfigLoaded || searchConfigTesting || searchConfigDraft.provider === 'disabled'\"",
  );
  assertFalse(html.includes("Control Plane"));
  assertFalse(html.includes("Data Plane"));
  assertFalse(
    html.indexOf("Search Provider") < html.indexOf("Premium Requests"),
  );
});

Deno.test("DashboardPage renders helper functions inside script without HTML entity encoding", () => {
  const html = DashboardPage().toString();

  assertStringIncludes(html, "const draftFromSearchConfig = ");
  assertStringIncludes(html, "const activeCredentialValue = ");
  assertStringIncludes(html, "const setActiveCredentialValue = ");
  assertStringIncludes(html, "const searchConfigFromDraft = ");
  assertFalse(html.includes("=&gt;"));
  assertFalse(html.includes("&quot;tavily&quot;"));
});
