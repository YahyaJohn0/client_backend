import { z } from "zod";

const imageSchema = z.object({
  url: z.string().url().max(2048),
  publicId: z.string().min(1).max(255),
}).strict();

const productObjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().min(1).max(80),
  description: z.string().max(10000).default(""),
  shortDescription: z.string().max(500).default(""),
  categoryId: z.string().min(1).max(128),
  price: z.number().finite().nonnegative(),
  salePrice: z.number().finite().nonnegative().nullable().default(null),
  stock: z.number().int().nonnegative(),
  images: z.array(imageSchema).max(12).default([]),
  isFeatured: z.boolean().default(false),
  isBestSeller: z.boolean().default(false),
  isTrending: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  isActive: z.boolean().default(true),
}).strict();

export const productInputSchema = productObjectSchema.superRefine((product, ctx) => {
  if (product.salePrice !== null && product.salePrice > product.price) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salePrice"], message: "Sale price cannot exceed regular price." });
  }
});

export const productPatchSchema = productObjectSchema.partial().strict().superRefine((product, ctx) => {
  if (product.salePrice != null && product.price != null && product.salePrice > product.price) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["salePrice"], message: "Sale price cannot exceed regular price." });
  }
});

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  image: z.string().url().max(2048).nullable().default(null),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().nonnegative().default(0),
}).strict();
export const categoryPatchSchema = categoryInputSchema.partial().strict();

export const orderInputSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(30),
    address: z.string().trim().min(5).max(1000),
    city: z.string().trim().min(1).max(120),
  }).strict(),
  items: z.array(z.object({
    productId: z.string().min(1).max(128),
    quantity: z.number().int().min(1).max(99),
  }).strict()).min(1).max(50),
  couponCode: z.string().trim().max(80).optional(),
  paymentMethod: z.enum(["cash_on_delivery"]),
}).strict();

export const customerProfilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  phoneNumber: z.string().trim().min(7).max(30).nullable().optional(),
}).strict();

export const orderStatusSchema = z.object({
  status: z.enum(["confirmed", "processing", "packed", "shipped", "out_for_delivery", "delivered", "cancelled", "returned"]),
}).strict();
export const productStatusSchema = z.object({ isActive: z.boolean() }).strict();
export const trackingSchema = z.object({ phone: z.string().trim().min(7).max(30) }).strict();
export const publicIdSchema = z.object({
  publicId: z.string().min(1).max(255).refine((value) => !value.includes("\\") && !value.split("/").includes(".."), "Invalid Cloudinary public ID."),
}).strict();
