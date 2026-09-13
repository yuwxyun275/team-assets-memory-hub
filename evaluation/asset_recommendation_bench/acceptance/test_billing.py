from decimal import Decimal
import unittest
from service import subtotal, total, invoice, line_total


def line(price, quantity=1, currency="CNY"):
    return {"price": price, "quantity": quantity, "currency": currency}


class Acceptance(unittest.TestCase):
    def test_round_each_line(self):
        self.assertEqual(subtotal([line("0.005"), line("0.005")], "CNY"), Decimal("0.02"))
        self.assertEqual(line_total("2.675", 1), Decimal("2.68"))
        self.assertEqual(line_total("0.335", 3), Decimal("1.01"))

    def test_credit_never_negative(self):
        self.assertEqual(total([line("2.00")], "CNY", "9.00"), Decimal("0.00"))
        self.assertEqual(total([line("2.00")], "CNY", "0.50"), Decimal("1.50"))
        self.assertEqual(total([line("2.00")], "CNY", "0.005"), Decimal("1.99"))
        with self.assertRaises(ValueError):
            total([line("2.00")], "CNY", "-1")

    def test_currency_not_mixed(self):
        with self.assertRaises(ValueError):
            subtotal([line("1.00"), line("1.00", currency="USD")], "CNY")
        self.assertEqual(subtotal([line("1.00")], "CNY"), Decimal("1.00"))

    def test_invalid_numeric_input(self):
        for price in ["NaN", "Infinity", "-0.01"]:
            with self.assertRaises(ValueError):
                line_total(price, 1)
        for qty in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError):
                line_total("1.00", qty)

    def test_empty_and_output(self):
        self.assertEqual(subtotal([], "CNY"), Decimal("0.00"))
        self.assertEqual(invoice([line("1.2")], "CNY"), {"currency": "CNY", "total": "1.20"})


if __name__ == "__main__":
    unittest.main()
