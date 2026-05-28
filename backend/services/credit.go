package services

import (
	"log"
	"time"

	"gorm.io/gorm"

	"market/models"
)

// AdjustCredit applies a delta to a user's credit score, clamps to
// [0, CreditMaxScore], and writes a CreditEvent log row in the same tx so
// the score and the audit log can never drift apart.
//
// `db` may be the root DB or an in-flight tx — callers in tx-bearing paths
// should pass their tx so the credit change is atomic with whatever
// triggered it (order confirm, seller cancel, etc.).
//
// Returns the new score. Errors are logged and swallowed: credit is a
// secondary concern, and a failed score update should never block the
// primary action (a successful order must commit even if its credit
// reward was lost — admin can reconcile from logs later).
func AdjustCredit(db *gorm.DB, userID uint, delta int, reason models.CreditEventReason, refType string, refID uint, note string) int {
	if userID == 0 || delta == 0 {
		return -1
	}

	var newScore int

	// Wrap in a mini-tx so the SELECT FOR UPDATE + UPDATE + INSERT are
	// atomic. We pick the new score inside the lock so CreditEvent.After
	// is guaranteed to be the value THIS adjustment produced, even when
	// two concurrent adjustments race.
	err := db.Transaction(func(tx *gorm.DB) error {
		// SELECT FOR UPDATE: serialises concurrent score changes for this
		// user. Without this, two goroutines both reading score=100, both
		// adding +5, would write 105 twice instead of 110.
		var u models.User
		if err := tx.Set("gorm:query_option", "FOR UPDATE").
			Select("id, credit_score").
			First(&u, userID).Error; err != nil {
			return err
		}

		newScore = u.CreditScore + delta
		if newScore < 0 {
			newScore = 0
		}
		if newScore > models.CreditMaxScore {
			newScore = models.CreditMaxScore
		}

		if err := tx.Model(&models.User{}).
			Where("id = ?", userID).
			Update("credit_score", newScore).Error; err != nil {
			return err
		}

		ev := models.CreditEvent{
			UserID:    userID,
			Delta:     delta,
			After:     newScore,
			Reason:    reason,
			RefType:   refType,
			RefID:     refID,
			Note:      note,
			CreatedAt: time.Now(),
		}
		return tx.Create(&ev).Error
	})
	if err != nil {
		log.Printf("AdjustCredit user=%d delta=%d: %v", userID, delta, err)
		return -1
	}
	return newScore
}
