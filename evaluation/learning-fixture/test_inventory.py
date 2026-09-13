import unittest
from inventory import Inventory


class InventoryTests(unittest.TestCase):
    def test_retry_does_not_deduct_again(self):
        inventory = Inventory({"book": 10})
        first = inventory.reserve("order-1", "book", 2)
        self.assertEqual(inventory.reserve("order-1", "book", 2), first)
        self.assertEqual(inventory.stock["book"], 8)

    def test_changed_quantity_conflicts_without_mutation(self):
        inventory = Inventory({"book": 10})
        inventory.reserve("order-1", "book", 2)
        with self.assertRaisesRegex(ValueError, "conflict"):
            inventory.reserve("order-1", "book", 3)
        self.assertEqual(inventory.stock["book"], 8)

    def test_independent_orders_remain_independent(self):
        inventory = Inventory({"book": 10})
        inventory.reserve("order-1", "book", 2)
        inventory.reserve("order-2", "book", 2)
        self.assertEqual(inventory.stock["book"], 6)


if __name__ == "__main__":
    unittest.main()
