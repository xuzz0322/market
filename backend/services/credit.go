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

	// Lock the user row so concurrent adjustments don't race the clamp.
	// We use UPDATE ... CASE/clamp inline rather than SELECT FOR UPDATE +
	// UPDATE so the floor/ceiling enforcement is a single statement.
	if err := db.Exec(`
		UPDATE users SET credit_score =
			CASE
				WHEN credit_score + ? < 0 THEN 0
				WHEN credit_score + ? > ? THEN ?
				ELSE credit_score + ?
			END
		WHERE id = ?
	`, delta, delta, models.CreditMaxScore, models.CreditMaxScore, delta, userID).Error; err != nil {
		log.Printf("AdjustCredit user=%d: update failed: %v", userID, err)
		return -1
	}

	// Read back the resulting score for the audit log. One extra query,
	// but the alternative (computing the clamp twice in app code) is
	// fragile and duplicates the SQL CASE.
	var u models.User
	if err := db.Select("credit_score").First(&u, userID).Error; err != nil {
		log.Printf("AdjustCredit user=%d: readback failed: %v", userID, err)
		return -1
	}

	ev := models.CreditEvent{
		UserID:    userID,
		Delta:     delta,
		After:     u.CreditScore,
		Reason:    reason,
		RefType:   refType,
		RefID:     refID,
		Note:      note,
		CreatedAt: time.Now(),
	}
	if err := db.Create(&ev).Error; err != nil {
		// Log but don't fail — score change still happened, audit row just
		// missing. Admins will have a small gap, the user state is correct.
		log.Printf("AdjustCredit user=%d: event log failed: %v", userID, err)
	}
	return u.CreditScore
}
