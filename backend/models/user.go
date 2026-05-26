package models

import (
	"time"

	"gorm.io/gorm"
)

// UserRole — system-wide role used for authorization.
//
//   user    : default — buyer, can browse and bid
//   seller  : merchant — can list products, create auctions, see seller stats
//   admin   : platform admin — full access (out of scope for self-service)
//
// Roles are single-valued (not a set) for simplicity. If we ever need
// hybrid permissions (e.g., a seller who also moderates) we'd switch to
// a separate roles table; for now this matches the product story.
type UserRole string

const (
	RoleUser   UserRole = "user"
	RoleSeller UserRole = "seller"
	RoleAdmin  UserRole = "admin"
)

func (r UserRole) IsValid() bool {
	switch r {
	case RoleUser, RoleSeller, RoleAdmin:
		return true
	}
	return false
}

type User struct {
	ID        uint           `json:"id" gorm:"primaryKey"`
	Username  string         `json:"username" gorm:"uniqueIndex;size:50;not null"`
	Email     string         `json:"email" gorm:"uniqueIndex;size:100;not null"`
	Password  string         `json:"-" gorm:"size:255;not null"`
	Avatar    string         `json:"avatar" gorm:"size:500"`
	Balance   float64        `json:"balance" gorm:"type:decimal(12,2);default:10000"`
	Role      UserRole       `json:"role" gorm:"type:varchar(20);default:'user';index"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `json:"-" gorm:"index"`
}
