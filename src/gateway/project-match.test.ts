import { expect, test } from "bun:test";
import { matchProjects } from "./project-match";

const P = (id: string, name = id) => ({ id, name, path: `/w/${id}` });

test("exact id or name wins, then a single substring, then a close typo", () => {
  const all = [P("default", "Default workspace"), P("tropos"), P("web-app", "Web App"), P("web-api")];
  expect(matchProjects("Web App", all).match?.id).toBe("web-app");
  expect(matchProjects("trop", all).match?.id).toBe("tropos");
  expect(matchProjects("tropso", all).match?.id).toBe("tropos");
  expect(matchProjects("web", all)).toEqual({ candidates: [all[2], all[3]] });
  expect(matchProjects("zzz", all)).toEqual({ candidates: [] });
});
