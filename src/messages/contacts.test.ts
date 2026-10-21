// src/messages/contacts.test.ts — address-book lookups over fixture databases
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Contacts } from "./contacts";
import { buildAddressBook } from "./testkit";

const dirs: string[] = [];
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "contacts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const people = [
  { first: "Maria", last: "Papadopoulou", phones: ["+30 691 234 5678"], emails: ["Maria@Example.com"] },
  { org: "Acme Plumbing", phones: ["210 555 0000"] },
];

describe("Contacts", () => {
  test("none() has no names and is unavailable", () => {
    const none = Contacts.none();
    expect(none.available).toBe(false);
    expect(none.nameOf("+306912345678")).toBeUndefined();
    expect(none.find("mar")).toEqual([]);
  });

  test("nameOf matches any spelling of a phone or an email", () => {
    const file = join(folder(), "a.abcddb");
    buildAddressBook(file, people);
    const contacts = Contacts.open([file]);
    expect(contacts.available).toBe(true);
    expect(contacts.nameOf("6912345678")).toBe("Maria Papadopoulou");
    expect(contacts.nameOf("00306912345678")).toBe("Maria Papadopoulou");
    expect(contacts.nameOf("maria@example.com")).toBe("Maria Papadopoulou");
    expect(contacts.nameOf("2105550000")).toBe("Acme Plumbing");
    expect(contacts.nameOf("+15550001111")).toBeUndefined();
  });

  test("the same digits under another country code are a different person", () => {
    const file = join(folder(), "a.abcddb");
    buildAddressBook(file, people);
    expect(Contacts.open([file]).nameOf("+16912345678")).toBeUndefined();
    buildAddressBook(file, [...people, { first: "Mary", phones: ["+1 691 234 5678"] }]);
    const contacts = Contacts.open([file]);
    expect(contacts.nameOf("+16912345678")).toBe("Mary");
    expect(contacts.nameOf("+306912345678")).toBe("Maria Papadopoulou");
    expect(contacts.nameOf("6912345678")).toBe("Maria Papadopoulou");
  });

  test("a query with no letters or digits finds nothing", () => {
    const file = join(folder(), "a.abcddb");
    buildAddressBook(file, people);
    expect(Contacts.open([file]).find("-")).toEqual([]);
  });

  test("find returns the contact with normalized handles", () => {
    const file = join(folder(), "a.abcddb");
    buildAddressBook(file, people);
    const found = Contacts.open([file]).find("mar");
    expect(found).toEqual([{ name: "Maria Papadopoulou", handles: ["+306912345678", "maria@example.com"] }]);
  });

  test("a file that fails to open is skipped and the rest still load", () => {
    const dir = folder();
    const good = join(dir, "good.abcddb");
    const bad = join(dir, "bad.abcddb");
    buildAddressBook(good, people);
    writeFileSync(bad, "this is not a database");
    const contacts = Contacts.open([join(dir, "missing.abcddb"), bad, good]);
    expect(contacts.available).toBe(true);
    expect(contacts.nameOf("6912345678")).toBe("Maria Papadopoulou");
  });

  test("only unreadable files leaves it unavailable", () => {
    expect(Contacts.open([join(folder(), "missing.abcddb")]).available).toBe(false);
  });
});
