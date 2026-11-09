"""Unit tests for todoist_import.build_plan and ops_for. Synthetic data only."""
import unittest

import todoist_import as ti


def snap():
    return {
        "projects": [{"id": "p1", "name": "Repairs"}, {"id": "p2", "name": "Sams Club"},
                     {"id": "p3", "name": "Getting Started"}],
        "sections": [{"id": "s1", "name": "Garage"}],
        "items": [
            {"id": "1", "content": "Fix door", "project_id": "p1", "section_id": "s1", "priority": 4,
             "description": "the side one", "added_at": "2026-01-02T00:00:00Z"},
            {"id": "2", "content": "Parent", "project_id": "p1", "priority": 1},
            {"id": "3", "content": "Child", "project_id": "p1", "parent_id": "2", "priority": 1},
            {"id": "4", "content": "Milk", "project_id": "p2", "priority": 1},
            {"id": "5", "content": "Sample", "project_id": "p3", "priority": 1},
            {"id": "6", "content": "Done already", "project_id": "p1", "checked": True},
            {"id": "7", "content": "Gone", "project_id": "p1", "is_deleted": True},
        ],
        "notes": [{"id": "n1", "item_id": "1", "content": "bought hinge", "posted_at": "2026-02-03T10:00:00Z"}],
    }


SPLIT = {"hohe": ["Repairs"], "donetick": ["Sams Club"], "exclude": {"Getting Started": "sample"}}


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.plan = ti.build_plan(snap(), SPLIT, "2026-11-08")
        self.by = {e["todoist_id"]: e for e in self.plan["entries"]}

    def test_counts_balance_and_ignore_closed(self):
        c = self.plan["counts"]
        self.assertEqual(c["source_open"], 5)  # 6 checked and 7 deleted are not counted
        self.assertEqual((c["import"], c["import_review"], c["excluded"]), (1, 2, 2))
        self.assertTrue(c["balanced"])
        self.assertNotIn("6", self.by)
        self.assertNotIn("7", self.by)

    def test_plain_task_mapping(self):
        t = self.by["1"]["hohe"]
        self.assertEqual(t["id"], "todoist-1")
        self.assertEqual(t["title"], "Fix door")
        self.assertEqual(t["tags"], ["todoist", "repairs", "garage"])
        self.assertIn("the side one", t["notes"])
        self.assertIn("Todoist comment 2026-02-03: bought hinge", t["notes"])
        self.assertIn("priority p1", t["notes"])  # kept for reference only
        self.assertEqual(t["review"], [])

    def test_subtasks_are_flattened_and_flagged(self):
        parent, child = self.by["2"], self.by["3"]
        self.assertEqual(parent["outcome"], "import-review")
        self.assertEqual(child["outcome"], "import-review")
        self.assertIn("review", parent["hohe"]["tags"])
        self.assertIn("todoist-3", parent["hohe"]["notes"])
        self.assertIn("todoist-2", child["hohe"]["notes"])

    def test_exclusions_carry_reasons(self):
        self.assertEqual(self.by["4"]["outcome"], "excluded")
        self.assertIn("Donetick", self.by["4"]["reason"])
        self.assertEqual(self.by["5"]["reason"], "sample")

    def test_unlisted_project_stops(self):
        with self.assertRaisesRegex(ValueError, "not in the split file"):
            ti.build_plan(snap(), {"hohe": ["Repairs"], "donetick": ["Sams Club"]}, "2026-11-08")

    def test_project_listed_twice_stops(self):
        with self.assertRaisesRegex(ValueError, "listed twice"):
            ti.build_plan(snap(), SPLIT | {"donetick": ["Sams Club", "Repairs"]}, "2026-11-08")

    def test_long_title_is_shortened_and_kept(self):
        s = snap()
        s["items"][0]["content"] = "x" * 600
        t = ti.build_plan(s, SPLIT, "2026-11-08")["entries"]
        t = next(e for e in t if e["todoist_id"] == "1")
        self.assertEqual(len(t["hohe"]["title"].encode()), 500)
        self.assertIn("x" * 600, t["hohe"]["notes"])
        self.assertEqual(t["outcome"], "import-review")

    def test_ops_shape(self):
        ops = ti.ops_for(self.by["1"]["hohe"])
        self.assertEqual([o["type"] for o in ops], ["capture", "edit", "edit"])
        self.assertEqual(ops[0]["taskId"], "todoist-1")
        self.assertNotIn("letter", ops[0])  # no priority letter, ever
        self.assertNotIn("day", ops[0])     # lands in the Task Dump
        self.assertEqual(ops[1]["dependsOn"], "todoist-1-capture")
        self.assertEqual(ops[2]["field"], "tags")


if __name__ == "__main__":
    unittest.main()
