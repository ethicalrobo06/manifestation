import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import connectToDatabase  from "@/lib/mongodb";
import User from "@/models/User";
import redis from "@/lib/redis";
import { z } from "zod";

const querySchema = z.object({
  page: z.string().optional().default("1").transform(Number),
  limit: z.string().optional().default("10").transform(Number),
  sortBy: z.enum(["date", "likes"]).optional().default("date"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional(),
});

const likeSchema = z.object({
  wishId: z.string(),
});

const commentSchema = z.object({
  wishId: z.string(),
  text: z.string().min(1, "Comment text is required"),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = querySchema.parse({
    page: searchParams.get("page"),
    limit: searchParams.get("limit"),
    sortBy: searchParams.get("sortBy"),
    sortOrder: searchParams.get("sortOrder"),
    search: searchParams.get("search"),
  });

  const { page, limit, sortBy, sortOrder, search } = query;
  const skip = (page - 1) * limit;

  const cacheKey = `public-wishes:${page}:${limit}:${sortBy}:${sortOrder}:${search || "no-search"}`;
  const cachedData = await redis.get(cacheKey);
  if (cachedData) {
    return NextResponse.json(JSON.parse(cachedData));
  }

  await connectToDatabase();

  const matchStage: any = { "wishes.isPublic": true };
  if (search) {
    matchStage["wishes.text"] = { $regex: search, $options: "i" };
  }

  const pipeline = [
    { $match: matchStage },
    { $unwind: "$wishes" },
    { $match: { "wishes.isPublic": true } },
    {
      $project: {
        wishId: "$wishes._id",
        text: "$wishes.text",
        date: "$wishes.date",
        likes: { $size: "$wishes.likes" },
        comments: "$wishes.comments",
        author: "$username",
      },
    },
    {
      $sort: {
        [sortBy === "likes" ? "likes" : "date"]: sortOrder === "asc" ? 1 : -1,
      },
    },
    { $skip: skip },
    { $limit: limit },
  ];

  const publicWishes = await User.aggregate(pipeline);

  const totalPipeline = [
    { $match: matchStage },
    { $unwind: "$wishes" },
    { $match: { "wishes.isPublic": true } },
    { $count: "total" },
  ];
  const totalResult = await User.aggregate(totalPipeline);
  const total = totalResult[0]?.total || 0;

  const response = {
    wishes: publicWishes,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };

  await redis.set(cacheKey, JSON.stringify(response), "EX", 300);
  return NextResponse.json(response);
}

export async function POST(req: NextRequest) {
  const isAuth = await isAuthenticated(req);
  if (!isAuth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = req.headers.get("x-user-id");
  const body = await req.json();
  const { wishId, text } = commentSchema.parse(body);

  await connectToDatabase();
  const user = await User.findOne({ "wishes._id": wishId });
  if (!user) {
    return NextResponse.json({ error: "Wish not found" }, { status: 404 });
  }

  const wish = user.wishes.id(wishId);
  if (!wish || !wish.isPublic) {
    return NextResponse.json({ error: "Wish not found or not public" }, { status: 404 });
  }

  wish.comments.push({ user: userId, text, date: new Date() });
  await user.save();

  const keys = await redis.keys("public-wishes:*");
  if (keys.length > 0) {
    await redis.del(keys);
  }

  return NextResponse.json({ message: "Comment added successfully" });
}

export async function PATCH(req: NextRequest) {
  const isAuth = await isAuthenticated(req);
  if (!isAuth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = req.headers.get("x-user-id");
  const body = await req.json();
  const { wishId } = likeSchema.parse(body);

  await connectToDatabase();
  const user = await User.findOne({ "wishes._id": wishId });
  if (!user) {
    return NextResponse.json({ error: "Wish not found" }, { status: 404 });
  }

  const wish = user.wishes.id(wishId);
  if (!wish || !wish.isPublic) {
    return NextResponse.json({ error: "Wish not found or not public" }, { status: 404 });
  }

  const hasLiked = wish.likes.includes(userId);
  if (hasLiked) {
    wish.likes = wish.likes.filter((id: string) => id.toString() !== userId);
  } else {
    wish.likes.push(userId);
  }
  await user.save();

  const keys = await redis.keys("public-wishes:*");
  if (keys.length > 0) {
    await redis.del(keys);
  }

  return NextResponse.json({ message: hasLiked ? "Like removed" : "Like added" });
}