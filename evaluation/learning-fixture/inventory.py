class Inventory:
    """Single-process fixture; does not claim transaction or restart safety."""
    def __init__(self, stock):
        self.stock = dict(stock)
        self.requests = {}

    def reserve(self, request_id, sku, count):
        if count <= 0:
            raise ValueError("invalid quantity")
        if request_id in self.requests:
            old_sku, old_count, result = self.requests[request_id]
            if (sku, count) != (old_sku, old_count):
                raise ValueError("request conflict")
            return result
        if self.stock.get(sku, 0) < count:
            raise ValueError("insufficient stock")
        self.stock[sku] -= count
        result = {"reserved": count, "sku": sku}
        self.requests[request_id] = (sku, count, result)
        return result
