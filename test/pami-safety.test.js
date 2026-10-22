import test from "node:test";
import assert from "node:assert/strict";
import { setup, tables, letters } from "./pami-fixture.js";
import { pamiCoverage, pamiMailSnapshot } from "../src/pami-mail.js";
test("Pami base9971 never sends an attachment whose current resource no longer exists", () => {
  const f = setup();
  try {
    f.store.transact(f.session.id, 0, (s) =>
      (s.taskRecords ??= []).push({ task_id: 206033, count: 1 }),
    );
    const out = f.call("EnterGame", { open_id: "pami-mail" }, {}),
      sync = out.find((p) => p.id === 9970).data;
    assert(
      !sync.mail_tab
        .flatMap((t) => t.contents)
        .some((e) => e.mail_id === 30101),
    );
    assert(
      pamiCoverage(tables).rejected.some(
        (r) => r.id === 30101 && r.reasons.some((x) => x.includes("305021")),
      ),
    );
  } finally {
    f.close();
  }
});
test("Pami quarantine preserves private delivered history while hiding invalid content from Native9970", () => {
  const f = setup();
  try {
    const saved = {
      mail_id: 30101,
      hero_id: "0",
      timestamp: f.now(),
      latest_read: true,
      reply: [{ text_id: 3010101, record: 0, timestamp: f.now() }],
      reward: [],
      args: [],
    };
    f.store.transact(f.session.id, 0, (s) => {
      s.pamiMail.letters[30101] = saved;
    });
    f.call("EnterGame", { open_id: "pami-mail" }, {});
    assert.deepEqual(f.state().pamiMail.letters[30101], saved);
    assert(!letters(f).some((e) => e.mail_id === 30101));
  } finally {
    f.close();
  }
});
test("Pami unknown attachment variants are quarantined generically and warnings deduplicate across catalogs", () => {
  const f = setup(),
    warn = console.warn,
    logs = [];
  const fake = () => ({
    get: (n) =>
      n === "pami_letter_text"
        ? tables
            .get(n)
            .map((r) => (r.id === 1068101 ? { ...r, reward: "999887#1#1" } : r))
        : tables.get(n),
    find: tables.find.bind(tables),
  });
  try {
    console.warn = (line) => logs.push(String(line));
    const first = fake(),
      second = fake(),
      state = f.state();
    assert(
      pamiCoverage(first).rejected.some(
        (r) =>
          r.id === 10681 &&
          r.reasons.some((s) => s.includes("unvalidated attachment type")),
      ),
    );
    pamiCoverage(first);
    pamiCoverage(second);
    assert.equal(logs.filter((s) => s.includes("999887")).length, 1);
    assert(
      !pamiMailSnapshot(first, state, f.now())
        .mail_tab.flatMap((t) => t.contents)
        .some((e) => e.mail_id === 10681),
    );
  } finally {
    console.warn = warn;
    f.close();
  }
});
