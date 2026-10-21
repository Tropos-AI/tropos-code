// src/messages/contacts.ts — read-only lookups of names for phone numbers and emails in the macOS address book
import { Database } from "bun:sqlite";
import { handleKeys, normalizeHandle, sameHandle } from "./handles";

interface Entry {
  name: string;
  handles: string[];
}

function personName(first: string | null, last: string | null, org: string | null): string | undefined {
  const person = [first, last].filter((part) => part && part.trim()).join(" ").trim();
  return person || org?.trim() || undefined;
}

/** Names from one or more AddressBook-v22.abcddb files, indexed by every key a handle can be written with. */
export class Contacts {
  private readonly byKey = new Map<string, Array<{ name: string; handle: string }>>();

  private constructor(
    private readonly entries: Entry[],
    readonly available: boolean,
  ) {
    for (const entry of entries) {
      for (const handle of entry.handles) {
        for (const key of handleKeys(handle)) {
          const list = this.byKey.get(key) ?? [];
          list.push({ name: entry.name, handle });
          this.byKey.set(key, list);
        }
      }
    }
  }

  /** Reads each file read-only; one that cannot be opened or understood is skipped. */
  static open(files: string[]): Contacts {
    const entries: Entry[] = [];
    let readAny = false;
    for (const file of files) {
      let db: Database | undefined;
      try {
        db = new Database(file, { readonly: true });
        const records = db
          .query("SELECT Z_PK AS pk, ZFIRSTNAME AS first, ZLASTNAME AS last, ZORGANIZATION AS org FROM ZABCDRECORD")
          .all() as Array<{ pk: number; first: string | null; last: string | null; org: string | null }>;
        const handles = new Map<number, string[]>();
        const add = (owner: number, value: string | null) => {
          if (!value || !value.trim()) return;
          const list = handles.get(owner) ?? [];
          const normalized = normalizeHandle(value);
          if (!list.includes(normalized)) list.push(normalized);
          handles.set(owner, list);
        };
        for (const row of db.query("SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER").all() as Array<{ owner: number; value: string | null }>) add(row.owner, row.value);
        for (const row of db.query("SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS").all() as Array<{ owner: number; value: string | null }>) add(row.owner, row.value);
        for (const record of records) {
          const name = personName(record.first, record.last, record.org);
          const list = handles.get(record.pk);
          if (name && list?.length) entries.push({ name, handles: list });
        }
        readAny = true;
      } catch {
        // An unreadable address book just contributes nothing.
      } finally {
        db?.close();
      }
    }
    return new Contacts(entries, readAny);
  }

  /** No address book at all: every lookup comes back empty. */
  static none(): Contacts {
    return new Contacts([], false);
  }

  /** The contact name for a phone number or email, written any way. */
  nameOf(handle: string): string | undefined {
    for (const key of handleKeys(handle)) {
      for (const candidate of this.byKey.get(key) ?? []) if (sameHandle(handle, candidate.handle)) return candidate.name;
    }
    return undefined;
  }

  /** Contacts whose name or any handle contains the text, case-insensitively. */
  find(query: string, limit = 10): Array<{ name: string; handles: string[] }> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const compact = normalizeHandle(needle);
    return this.entries
      .filter((e) => e.name.toLowerCase().includes(needle) || (compact !== "" && e.handles.some((h) => h.toLowerCase().includes(compact))))
      .slice(0, limit)
      .map((e) => ({ name: e.name, handles: [...e.handles] }));
  }
}
