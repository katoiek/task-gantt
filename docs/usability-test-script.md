# Usability test script: role views, execution boards, interruptions

Compare the baseline (230a596) with the revision, one session per participant, at least one participant per role. Give no coaching; read only the task line. For each task record: success (yes / with help / no), time from reading the task to the answer, errors (wrong row, wrong board, wrong file changed), and anything the participant says is confusing.

Targets (not results): overview answers within 10 seconds; a visible task to its execution board within two actions; critical workflows completed without coaching.

## Setup

- A vault with:
  - two project folders, one of them Hebrew-named (`איחוד סביבות`), plus standalone tasks at the board root;
  - in a project: an undated task, a task starting next week, a blocked task, an overdue task, a task with two scheduled subtask notes;
  - `DB Adapter`: a Kanban note with phase lanes (`שלב 1 – תכנון`, `שלב 2 – מימוש`, …) and 7 cards, some checked;
  - an ordinary small standalone task (`Order cables`);
  - two urgent-capable standalone tasks (`Hotfix login`, `DB outage`) assigned to Dana, who has `DB Adapter` and a shared task (Dana + Eli) in progress.
- Kanban plugin enabled, except in task M4.
- For R1: Vault Rooms with a room the participant can only read.

## Section head

- S1. "Which projects have work under way right now?" (expect: Overview preset or the folder headings)
- S2. "In איחוד סביבות, what is the next task planned to start?" (expect: the start dates or the Upcoming 2 weeks preset; not a Kanban card)
- S3. "Is anything waiting on a decision or stuck? Why?" (expect: Attention preset or a tag such as *Overdue +1*, then the reasons in the details)

## Team leader

- L1. "Who is blocked or interrupted, and by what?" (expect: Team preset, the tag, and the panel's *Interrupted by Hotfix login (Dana)*)
- L2. "Which person has the most open work?" (expect: the heading counts under Team)
- L3. "Mark Hotfix login as urgent work interrupting Dana." (expect: the Priority row's button; in the chooser, pick DB Adapter and not the shared task)

## Team member (as Dana)

- M1. "Open the board for DB Adapter and find the next step." (expect: the board cue or **Open board**, within two actions)
- M2. "Move the error-handling card before the adapter card." (expect: drag on the Kanban board; back on the Gantt the cue names the moved card)
- M3. "Hotfix login and DB outage both interrupted DB Adapter. Finish Hotfix login, then DB outage, then return to your normal work." (expect: no Resume after the first; **Resume DB Adapter** after the second; the board opens; DB Adapter's status is unchanged)
- M4. With the Kanban plugin disabled: "Open the DB Adapter board and reorder a card." (expect: the notice explains Markdown lanes and list items)

## Read-only and refresh

- R1. In the read-only room: "Change the due date of a task." (expect: the lock, the panel's explanation, no copy file left by Vault Rooms)
- R2. While a task's details are open and the board is scrolled, a colleague edits another task. (expect: the board updates; selection, scroll and focus stay)

## Afterwards

Ask each participant: "What did the tag on a row mean?", "What does 3/7 on a board mean?" (expect: cards checked, not effort or schedule), and "Where do your view settings live?"
