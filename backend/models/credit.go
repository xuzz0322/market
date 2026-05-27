package models

import "time"

// CreditEventReason enumerates why a credit adjustment happened. Stored as
// the typed Reason column so admins can group/filter audit logs by event
// type without parsing free text.
type CreditEventReason string

const (
	CreditReasonOrderCompleted   CreditEventReason = "order_completed"     // +5 buyer
	CreditReasonOrderShipped     CreditEventReason = "order_shipped"       // +2 seller
	CreditReasonSellerCancelled  CreditEventReason = "seller_cancelled"    // -5 seller (mid-auction)
	CreditReasonAdminAdjust      CreditEventReason = "admin_adjust"        // arbitrary delta
	CreditReasonNewUserBonus     CreditEventReason = "new_user_bonus"      // unused for now; reserved
)

// CreditEvent is an append-only audit log of every credit-score change. We
// don't soft-delete — credit history must be tamper-evident. Storing the
// resulting score (After) on every row makes "what was their score on X
// date" answerable from the log alone, without replaying every event.
type CreditEvent struct {
	ID        uint              `json:"id" gorm:"primaryKey"`
	UserID    uint              `json:"user_id" gorm:"not null;index"`
	Delta     int               `json:"delta" gorm:"not null"`
	After     int               `json:"after" gorm:"not null;comment:'score after this delta'"`
	Reason    CreditEventReason `json:"reason" gorm:"type:varchar(40);not null;index"`
	RefType   string            `json:"ref_type" gorm:"size:30;comment:'order|auction|admin'"`
	RefID     uint              `json:"ref_id"`
	Note      string            `json:"note" gorm:"size:200"`
	CreatedAt time.Time         `json:"created_at"`
}
