import { extendOrderAction } from "@/app/actions/orders";
import { MAX_EXTEND_DAYS } from "@/lib/orders";

/**
 * Admin: add days to an order's turnaround before it auto-cancels (5 Nov 2026).
 * Used in the Admin -> Orders tables and on the order page.
 */
export default function ExtendOrderForm({
  orderId,
  back = "admin",
  compact = false,
}: {
  orderId: number;
  back?: "admin" | "order";
  compact?: boolean;
}) {
  return (
    <form action={extendOrderAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="back" value={back} />
      {compact ? (
        <input
          className="input w-20 py-2"
          name="days"
          type="number"
          min="1"
          max={MAX_EXTEND_DAYS}
          step="1"
          defaultValue="3"
          required
          aria-label="Days to add"
        />
      ) : (
        <label className="field mb-0 w-32">
          <span>Days to add</span>
          <input className="input" name="days" type="number" min="1" max={MAX_EXTEND_DAYS} step="1" defaultValue="3" required />
        </label>
      )}
      <button className="btn-ghost btn-sm whitespace-nowrap" type="submit">
        {compact ? "Extend" : "Extend deadline"}
      </button>
    </form>
  );
}
