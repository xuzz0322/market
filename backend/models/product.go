package models

import (
	"time"

	"gorm.io/gorm"
)

type ProductStatus string

const (
	ProductDraft     ProductStatus = "draft"
	ProductActive    ProductStatus = "active"
	ProductAuction   ProductStatus = "auctioning"
	ProductSold      ProductStatus = "sold"
	ProductEnded     ProductStatus = "ended"
)

type Product struct {
	ID          uint           `json:"id" gorm:"primaryKey"`
	SellerID    uint           `json:"seller_id" gorm:"not null;index"`
	Seller      *User          `json:"seller,omitempty" gorm:"foreignKey:SellerID"`
	Title       string         `json:"title" gorm:"size:200;not null"`
	Description string         `json:"description" gorm:"type:text"`
	Images      string         `json:"images" gorm:"type:json"`
	VideoURL    string         `json:"video_url" gorm:"size:500"`
	Category    string         `json:"category" gorm:"size:50"`
	Status      ProductStatus  `json:"status" gorm:"type:varchar(20);default:'draft'"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `json:"-" gorm:"index"`
}
