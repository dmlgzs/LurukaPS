// Presentation receipts contain rewards already granted by the order transaction.
// Both an online delivery and the client's follow-up query consume the same FIFO.
export function takeRechargePopup(state) {
    const mall = state.mall,
        popup = mall?.popupQueue?.shift()
    if (popup != null) return popup
    // This pre-existing single-receipt fallback has no known historical producer.
    // If present, return its exact payload once; otherwise CBT3 keeps querying it.
    const pending = mall?.pendingPopup
    if (pending != null) {
        delete mall.pendingPopup
        return pending
    }
    return { popup_id: 0 }
}

export function notifyRechargePopup(c) {
    if (!c.state.mall?.popupQueue?.length) return
    // CBT3's public 18048 parser presents this receipt, then requests the next.
    // Encoding occurs within Game's transaction, so failure also restores the FIFO.
    c.push('CSProtoGetRechargePopupData', takeRechargePopup(c.state))
}
