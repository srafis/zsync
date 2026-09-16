import { expect, test } from "bun:test";
import { chooseProject, matchingJob, tagJobName } from "./cli.ts";
import type { Project } from "./types.ts";

test("project picker offers creation first and adds the created project for reuse", async () => {
  const projects = [{ id: "old", name: "CineMotion" }];
  const created = { id: "new", name: "non-existing-project-1" };
  const result = await chooseProject(created.name, projects, async name => {
    expect(name).toBe(created.name);
    return created;
  }, async prompt => {
    expect(prompt.options.map(option => option.label)).toEqual(['Create "non-existing-project-1"', "CineMotion"]);
    return prompt.options[0]!.value;
  });
  expect(result).toEqual(created);
  expect(projects).toEqual([{ id: "old", name: "CineMotion" }, created]);
});

test("project creation works when no Zoho projects exist", async () => {
  const projects: Project[] = [];
  const created = { id: "new", name: "First project" };
  expect(await chooseProject(created.name, projects, async () => created, async prompt => prompt.options[0]!.value)).toEqual(created);
});

test("selecting an existing project or cancelling does not create a project", async () => {
  const projects = [{ id: "old", name: "CineMotion" }];
  let writes = 0;
  const create = async () => { writes++; return { id: "new", name: "New" }; };
  expect(await chooseProject("New", projects, create, async () => "old")).toEqual(projects[0]!);
  await expect(chooseProject("New", projects, create, async () => Symbol("cancel"))).rejects.toThrow();
  expect(writes).toBe(0);
  expect(projects).toHaveLength(1);
});

test("failed project creation does not add a project", async () => {
  const projects: Project[] = [];
  await expect(chooseProject("New", projects, async () => { throw new Error("Permission denied"); }, async prompt => prompt.options[0]!.value)).rejects.toThrow("Permission denied");
  expect(projects).toEqual([]);
});

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
