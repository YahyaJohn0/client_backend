import { describe, expect, it } from "vitest";
import { createDemoProductRecord, normalizeDemoProduct } from "../src/demoProducts.js";

describe("Realtime Database demo products", () => {
  it("normalizes seeded string image URLs and retains Cloudinary metadata", () => {
    const product = normalizeDemoProduct("demo-item", {
      name: "Demo item",
      images: ["https://res.cloudinary.com/example/image/upload/demo.jpg"],
      imageMetadata: [{
        url: "https://res.cloudinary.com/example/image/upload/demo.jpg",
        publicId: "samples/ecommerce/demo",
      }],
      isActive: true,
    });

    expect(product.id).toBe("demo-item");
    expect(product.images).toEqual(["https://res.cloudinary.com/example/image/upload/demo.jpg"]);
    expect(product.imageMetadata).toEqual([{
      url: "https://res.cloudinary.com/example/image/upload/demo.jpg",
      publicId: "samples/ecommerce/demo",
    }]);
  });

  it("stores Cloudinary URLs and metadata without changing stable product IDs", () => {
    const existing = {
      id: "demo-item",
      createdAt: "2026-01-01T00:00:00.000Z",
      isDemo: true,
      seededBy: "original-seeder",
      customDemoField: "preserved",
    };
    const imageUrl = "https://res.cloudinary.com/example/image/upload/product.jpg";
    const record = createDemoProductRecord("demo-item", {
      name: "Updated item",
      images: [{ url: imageUrl, publicId: "samples/ecommerce/product" }],
      isActive: true,
    }, existing, "2026-02-01T00:00:00.000Z", "admin-uid");

    expect(record.id).toBe("demo-item");
    expect(record.images).toEqual([imageUrl]);
    expect(record.imageUrl).toBe(imageUrl);
    expect(record.imageMetadata).toEqual([expect.objectContaining({
      url: imageUrl,
      publicId: "samples/ecommerce/product",
    })]);
    expect(record.createdAt).toBe(existing.createdAt);
    expect(record.customDemoField).toBe("preserved");
    expect(record.seededBy).toBe("admin-dashboard");
    expect(record.updatedBy).toBe("admin-uid");
  });

  it("preserves image records when an edit does not include a new image list", () => {
    const previousMetadata = [{
      url: "https://res.cloudinary.com/example/image/upload/old.jpg",
      publicId: "samples/ecommerce/old",
    }];
    const record = createDemoProductRecord("demo-item", { stock: 4 }, {
      images: [previousMetadata[0]!.url],
      imageMetadata: previousMetadata,
      imageUrl: previousMetadata[0]!.url,
    }, "2026-02-01T00:00:00.000Z", "admin-uid");

    expect(record.images).toEqual([previousMetadata[0]!.url]);
    expect(record.imageMetadata).toEqual(previousMetadata);
    expect(record.imageUrl).toBe(previousMetadata[0]!.url);
  });
});
