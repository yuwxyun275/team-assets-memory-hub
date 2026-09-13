import unittest
from service import Inventory


class Acceptance(unittest.TestCase):
    def test_atomic_failure(self):
        inv = Inventory({("a", "x"): 5, ("a", "y"): 0})
        before = inv.snapshot()
        with self.assertRaises(ValueError):
            inv.reserve("a", "r", {"x": 2, "y": 1})
        self.assertEqual(inv.snapshot(), before)
        self.assertEqual(inv.reservation_count(), 0)

    def test_idempotence_and_conflict(self):
        inv = Inventory({("a", "x"): 9})
        inv.reserve("a", "r", {"x": 2})
        inv.reserve("a", "r", {"x": 2})
        self.assertEqual(inv.available("a", "x"), 7)
        with self.assertRaises(ValueError):
            inv.reserve("a", "r", {"x": 3})
        self.assertEqual(inv.available("a", "x"), 7)

    def test_release_once(self):
        inv = Inventory({("a", "x"): 9})
        inv.reserve("a", "r", {"x": 2})
        self.assertTrue(inv.release("a", "r"))
        self.assertFalse(inv.release("a", "r"))
        self.assertEqual(inv.available("a", "x"), 9)
        self.assertTrue(inv.is_released("a", "r"))

    def test_tenant_keys(self):
        inv = Inventory({("a", "x"): 9, ("b", "x"): 8})
        inv.reserve("a", "r", {"x": 2})
        inv.reserve("b", "r", {"x": 3})
        self.assertEqual(inv.available("a", "x"), 7)
        self.assertEqual(inv.available("b", "x"), 5)

    def test_invalid_quantities(self):
        inv = Inventory({("a", "x"): 9})
        for value in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                inv.reserve("a", str(value), {"x": value})
        self.assertEqual(inv.available("a", "x"), 9)

    def test_missing_release_and_snapshot_copy(self):
        inv = Inventory({("a", "x"): 2})
        self.assertFalse(inv.release("b", "r"))
        state = inv.snapshot()
        state[("a", "x")] = 100
        self.assertEqual(inv.available("a", "x"), 2)


if __name__ == "__main__":
    unittest.main()
