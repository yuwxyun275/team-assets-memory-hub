"""Synthetic in-process inventory, not a concurrent production stock service."""
class Inventory:
    def __init__(self, stocks):
        self.stocks = dict(stocks)
        self.reservations = {}

    def available(self, tenant, sku):
        return self.stocks.get((tenant, sku), 0)

    def validate_lines(self, lines):
        if not lines or any(type(q) is not int or q <= 0 for q in lines.values()):
            raise ValueError("positive integer quantities required")

    def reservation_key(self, tenant, request_id):
        return (tenant, request_id)

    def reserve(self, tenant, request_id, lines):
        self.validate_lines(lines)
        key = self.reservation_key(tenant, request_id)
        existing = self.reservations.get(key)
        if existing is not None:
            if existing["lines"] != dict(lines):
                raise ValueError("idempotency payload conflict")
            return dict(existing["lines"])
        if any(self.available(tenant, sku) < qty for sku, qty in lines.items()):
            raise ValueError("insufficient stock")
        for sku, qty in lines.items():
            self.stocks[(tenant, sku)] = self.available(tenant, sku) - qty
        self.reservations[key] = {"lines": dict(lines), "released": False}
        return dict(lines)

    def release(self, tenant, request_id):
        key = self.reservation_key(tenant, request_id)
        item = self.reservations.get(key)
        if item is None or item["released"]:
            return False
        for sku, qty in item["lines"].items():
            self.stocks[(tenant, sku)] = self.available(tenant, sku) + qty
        item["released"] = True
        return True

    def is_released(self, tenant, request_id):
        item = self.reservations.get(self.reservation_key(tenant, request_id))
        return bool(item and item["released"])

    def reservation_count(self):
        return len(self.reservations)

    def snapshot(self):
        return dict(self.stocks)
