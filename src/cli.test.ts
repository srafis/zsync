import { expect, test } from "bun:test";
import { matchingJob, tagJobName } from "./cli.ts";

test("tag jobs use the first alphabetical tag and N/A when empty", () => {
  expect(tagJobName(["Zulu", "alpha", "Beta"])).toBe("alpha");
  expect(tagJobName(["  Support  "])).toBe("Support");
  expect(tagJobName([])).toBe("N/A");
});

test("job matching is case-insensitive and project-scoped", () => {
  const jobs = [
    { id: "one", name: "Support", projectId: "project-a" },
    { id: "two", name: "support", projectId: "project-b" },
  ];
  expect(matchingJob("project-a", "support", jobs)?.id).toBe("one");
  expect(matchingJob("project-c", "support", jobs)).toBeUndefined();
});
