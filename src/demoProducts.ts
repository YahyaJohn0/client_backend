type DemoProductRecord = Record<string, unknown>;

export interface NormalizedDemoProduct extends DemoProductRecord {
  id: string;
  name: string;
  sku: string;
  description: string;
  shortDescription: string;
  categoryId: string;
  price: number;
  salePrice: number | null;
  stock: number;
  images: string[];
  imageMetadata: unknown[];
  isFeatured: boolean;
  isBestSeller: boolean;
  isTrending: boolean;
  isNewArrival: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function normalizeDemoProduct(id: string, value: DemoProductRecord): NormalizedDemoProduct {
  const rawImages = Array.isArray(value.images) ? value.images : [];
  const imageMetadata = Array.isArray(value.imageMetadata)
    ? value.imageMetadata
    : rawImages.flatMap((image, index) =>
      image && typeof image === "object" && typeof image.url === "string"
        ? [{ ...image, isPrimary: index === 0 }]
        : [],
    );
  const images = rawImages.flatMap((image) =>
    typeof image === "string"
      ? [image]
      : image && typeof image === "object" && typeof image.url === "string"
        ? [image.url]
        : [],
  );

  return {
    ...value,
    id,
    name: String(value.name ?? ""),
    sku: String(value.sku ?? ""),
    description: String(value.description ?? ""),
    shortDescription: String(value.shortDescription ?? ""),
    categoryId: String(value.categoryId ?? ""),
    price: Number(value.price ?? 0),
    salePrice: value.salePrice == null ? null : Number(value.salePrice),
    stock: Number(value.stock ?? 0),
    images,
    imageMetadata,
    isFeatured: Boolean(value.isFeatured),
    isBestSeller: Boolean(value.isBestSeller),
    isTrending: Boolean(value.isTrending),
    isNewArrival: Boolean(value.isNewArrival),
    isActive: Boolean(value.isActive),
    createdAt: String(value.createdAt ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
  } as NormalizedDemoProduct;
}

export function createDemoProductRecord(
  id: string,
  input: Record<string, unknown>,
  existing: DemoProductRecord | null,
  now: string,
  adminUid: string,
): DemoProductRecord {
  const { images: inputImages, ...fields } = input;
  const existingImageMetadata = Array.isArray(existing?.imageMetadata)
    ? existing.imageMetadata as Array<Record<string, unknown>>
    : [];
  const imageMetadata: Array<Record<string, unknown>> = Array.isArray(inputImages)
    ? inputImages.map((image, index) => {
      const entry = image as Record<string, unknown>;
      return {
        url: entry.url,
        publicId: entry.publicId,
        altText: typeof entry.altText === "string" ? entry.altText : String(input.name ?? ""),
        isPrimary: index === 0,
        sortOrder: index,
      };
    })
    : existingImageMetadata;
  const imageUrls = Array.isArray(inputImages)
    ? imageMetadata.map((image) => String(image.url))
    : Array.isArray(existing?.images) ? existing.images : [];

  return {
    ...existing,
    ...fields,
    id,
    images: imageUrls,
    imageMetadata,
    imageUrl: imageUrls[0] ?? null,
    isDemo: true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: existing?.createdBy ?? adminUid,
    updatedBy: adminUid,
    seededBy: "admin-dashboard",
  };
}
