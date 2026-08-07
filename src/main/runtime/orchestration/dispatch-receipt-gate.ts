import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { getProcessDispatchReceiptAuthority } from './dispatch-receipt-authority'

// Verifies a product-verified dispatch receipt and atomically consumes its
// reservation. Throws a structured OrchestrationError on any failure and
// returns the consumed reservation on success. Shared by dispatch and
// worker-start so neither internal path can bypass the product-verified
// routing gate (contracts 4-5).
export type ConsumedReceiptReservation = {
  dispatchId: string
  routingOutput: string
}

export function consumeProductVerifiedReceipt(args: {
  db: OrchestrationDb
  receipt: string | undefined
  runId: string
  taskId: string
  assigneeHandle?: string
  assigneePaneKey?: string | null
  processIncarnation?: string | null
}): ConsumedReceiptReservation {
  if (!args.receipt) {
    throw new OrchestrationError(
      'receipt_missing',
      'A product-verified dispatch receipt is required. Run `orchestration dispatch reserve` first.'
    )
  }
  const result = getProcessDispatchReceiptAuthority().verifyReceipt(args.receipt, {
    runId: args.runId,
    taskId: args.taskId,
    assigneeHandle: args.assigneeHandle,
    assigneePaneKey: args.assigneePaneKey,
    processIncarnation: args.processIncarnation
  })
  if (!result.valid) {
    throw new OrchestrationError(result.code, result.reason)
  }
  const reservation = args.db.consumeDispatchReceiptReservation(
    result.receipt.dispatchId,
    result.receipt.jti
  )
  if (!reservation) {
    throw new OrchestrationError(
      'dispatch_not_reserved',
      `Dispatch ${result.receipt.dispatchId} is not reserved or was already consumed.`
    )
  }
  return { dispatchId: reservation.dispatch_id, routingOutput: reservation.routing_output_json }
}
