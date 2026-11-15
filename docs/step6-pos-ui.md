# Step 6: POS Billing Frontend Architecture & Security Specification

This document details the architecture, keyboard-first operational model, data protection guarantees, financial calculations, and testing strategy for the Point of Sale (POS) Billing frontend (`apps/web`).

---

## 1. System Architecture & Component Hierarchy

The POS billing application is designed as a high-throughput, low-latency Single Page Application (SPA) built with React 19, Vite, Tailwind CSS, and Lucide icons, fully optimized for standard 1366x768 pharmacy terminal displays.

```
App.tsx
├── AuthProvider (AuthContext.tsx)
│   ├── LoginView.tsx (if unauthenticated)
│   └── MainLayout
│       ├── OfflineBanner.tsx (Network status indicator)
│       ├── Navbar.tsx (User badge, tab switching, shortcut guide, logout)
│       └── PosProvider (PosContext.tsx)
│           ├── PosBillingView.tsx (Active POS billing interface)
│           │   ├── ProductSearch.tsx (pg_trgm search & barcode scanner reader)
│           │   ├── CartTable.tsx (Line items, FEFO batch breakdown, line discounts)
│           │   ├── CartSummary.tsx (Totals preview, bill discount, hold/pay action triggers)
│           │   ├── CustomerDialog.tsx (Customer lookup & quick-create modal - F4)
│           │   ├── RxModal.tsx (Doctor & Patient details for Rx dispensing)
│           │   ├── PaymentDialog.tsx (Multi-tender payment settlement - F9)
│           │   ├── ReceiptModal.tsx (Thermal 80mm receipt preview & print)
│           │   ├── HoldBillsModal.tsx (Hold cart, resume with repricing, discard - F8)
│           │   └── ShortcutHelpModal.tsx (Keyboard shortcuts cheat sheet - ?)
│           └── SalesHistoryView.tsx (Transaction audit log, reprint, and void modal)
```

---

## 2. Keyboard-First Interaction & Hardware Barcode Integration

The POS terminal is engineered for non-stop cashier operation without requiring mouse interaction:

- **Hardware Barcode Scanners**: Automatically intercepts scanner keystrokes terminating in `Enter`. Scanners typing digits or letters immediately query `/api/v1/products/search?q=...` and add exact barcode matches directly to the cart.
- **Global Hotkey Bindings**:
  - `F2`: Instantly focuses and selects the product search bar from anywhere on the screen.
  - `F4`: Opens the Customer Selection / Quick Create dialog.
  - `F8`: Opens the Hold Bills dialog to suspend or resume sales.
  - `F9`: Opens the Payment & Checkout dialog. In payment mode, `F9` confirms and triggers receipt printing.
  - `Esc`: Closes any open modal/dialog or cancels the current action, immediately returning focus to the product search input.
  - `Ctrl + Delete`: Triggers the cart clear confirmation dialog.
  - `?`: Displays the Keyboard Shortcut Reference modal.
- **Arrow-Key Search Navigation**: Up/Down arrow keys highlight search results, and `Enter` adds the highlighted item.

---

## 3. Financial Precision: Pure Math Preview vs Server Authority

To eliminate floating-point rounding inaccuracies in financial transactions:

1. **Client-Side Preview Math (`decimal.js`)**:
   - Every calculation (line discount, bill discount, tax rate, gross subtotal, grand total) is computed strictly using `Decimal.js` (`utils/cartMath.ts`). No native JavaScript `parseFloat` or IEEE-754 arithmetic is permitted.
   - All monetary values are rendered in standard Sri Lankan Rupees format: `Rs. 1,234.50`.
   - The UI clearly labels all totals as **Preview (Authoritative on checkout)**.
2. **Server Authority**:
   - The backend Step 5 billing engine is the ultimate single source of truth for bill calculation, FEFO allocation, line tax, and ledger postings.
   - Upon completing checkout (`POST /api/v1/sales`), the returned invoice (`sale` / `receiptData`) is stored and rendered on the receipt.

---

## 4. Cashier Role Data Protection Guarantees

In accordance with strict pharmacy retail data protection policies:

- **Zero Information Leakage**: Cashier roles are strictly prevented from viewing purchase costs, unit cost prices, profit margins, supplier details, or supplier invoices.
- **Defense in Depth**:
  1. *Backend Enforcement*: `sale.routes.ts` whitelists response DTOs for `cashier` users, scrubbing `costPrice`, `profit`, and supplier information before transmission.
  2. *Frontend FEFO Obfuscation*: `CartTable.tsx` and `ProductSearch.tsx` conditionally render detailed batch cost breakdowns only for `owner` and `pharmacist` roles. Cashiers only observe sellable retail MRP and total stock available.
  3. *Sales History Scoping*: Cashiers are limited to inspecting their own sales executed during the current business day. Historical cross-cashier sales and void operations are restricted to `pharmacist` and `owner` roles.

---

## 5. Prescription (Rx) Security & Role Enforcement

- **Restricted Dispensing**: Products flagged with `requires_prescription = true` require authorized supervision.
- **Pharmacist / Owner Verification**:
  - Cashier attempts to confirm prescription sales are actively blocked with a `403 FORBIDDEN` / `Pharmacist Required` UI gate.
  - Only authorized pharmacists or owners can input doctor names, registration numbers, and patient details via `RxModal.tsx`.

---

## 6. Role-Based Discount Thresholds

Discounts are strictly validated client-side and server-side:

| Role | Maximum Combined Discount % | Allowed Overrides |
| :--- | :--- | :--- |
| **Cashier** | **5.00%** | Hard-capped; values > 5% disable checkout button. |
| **Pharmacist** | **15.00%** | Hard-capped; values > 15% disable checkout button. |
| **Owner** | **100.00%** | Full administrative discretion. |

If a cashier attempts to apply a combined line + bill discount exceeding 5%, the UI immediately renders an alert banner: `Cashier discount exceeds maximum allowed (5%)` and disables the payment submission button.

---

## 7. Idempotency Key Lifecycle & Network Retry Safety

To protect against duplicate charges during network intermittency:

1. **UUIDv4 Key Generation**: A unique client UUID idempotency key is generated when items are added to the cart.
2. **Key Preservation Across Failures**:
   - If a checkout request fails due to network disconnection or temporary database deadlock (HTTP 500 / 0), the UI transitions to a `Retry Checkout` state while **retaining the exact same idempotency key**.
   - Submitting a retry sends the identical key and payload, allowing the backend to safely deduplicate or return the existing transaction.
3. **Key Reset Invariants**:
   - Modifying cart quantities, adding/removing lines, or changing customer details automatically regenerates a fresh idempotency key.
   - A successful sale completion clears the cart and resets the session idempotency state.

---

## 8. Thermal Receipt Specifications (80mm ESC/POS Layout)

The receipt preview and print module (`ReceiptModal.tsx`) conforms to 80mm ESC/POS thermal printing standards:

- **CSS Print Stylesheet**:
  ```css
  @media print {
    @page {
      size: 80mm auto;
      margin: 0;
    }
    body {
      margin: 0;
      padding: 0;
      background: #fff;
    }
    .no-print {
      display: none !important;
    }
  }
  ```
- **Monospace Alignment**: Rendered using fixed-width font (`font-mono`) with 42-column character line wrapping.
- **Duplicate & Reprint Watermarks**:
  - If a receipt has been retrieved or printed previously, the backend logs an audit event (`RECEIPT_REPRINTED`) and marks `isDuplicate = true`.
  - The receipt prints an explicit header: `*** DUPLICATE RECEIPT ***` with reprint count to prevent fraudulent claims.

---

## 9. Verification & Test Suite Summary

The entire POS subsystem is validated across three comprehensive test layers:

1. **Backend Integration Tests (`apps/api`)**:
   - 152 tests covering migrations 001–008, FEFO batch allocation, stock triggers, audit trail immutability, role permissions, and cashier DTO scrubbing.
2. **Frontend Unit & Component Tests (`apps/web` - Vitest)**:
   - 14 tests verifying `decimal.js` monetary calculations, Rx modal cashier restrictions, role-based discount threshold enforcement, and idempotency key preservation during network errors.
3. **Playwright End-to-End Tests (`e2e/pos_billing.spec.ts`)**:
   - Complete checkout workflow: Scanner input -> Cart addition -> Customer assignment -> Cash tender settlement -> 80mm Thermal Receipt generation.
   - Cashier data isolation verification: Confirms zero exposure of cost price, profit, margin, or supplier fields.
