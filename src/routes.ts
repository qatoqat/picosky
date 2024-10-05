import { FastifyInstance } from "fastify";
import type { AppContext } from "./index.js";
import { countGrapheme } from "unicode-segmenter";
import * as t from "tschema";
import { writeRecord } from "./rpc.js";
import * as TID from "@atcute/tid";
import { CHARLIMIT, env, GRAPHLIMIT } from "./env.js";

const PostSchema = t.object({ post: t.string() });
type PostInterface = t.Infer<typeof PostSchema>;

const GetPostsSchema = t.object({
  limit: t.integer({ minimum: 1, maximum: 100, default: 50 }),
  cursor: t.optional(t.integer({ minimum: 0 })),
});
type GetPostsInterface = t.Infer<typeof GetPostsSchema>;

export const createRouter = (server: FastifyInstance, ctx: AppContext) => {
  server.register(async () => {
    const stream = server.websocketServer;
    stream.setMaxListeners(0);
    server.post<{ Body: PostInterface }>(
      "/post",
      {
        schema: { body: PostSchema },
        config: {
          rateLimit: {
            max: 20,
            timeWindow: "1m",
          },
        },
      },
      async (req, res) => {
        const post = req.body.post;

        if (countGrapheme(post) > GRAPHLIMIT || post.length > CHARLIMIT)
          return res.status(400).send("Character limit exceeded.");
        else if (!countGrapheme(post.trim()))
          return res.status(400).send("Post cannot be empty.");

        const rkey = TID.now();
        writeRecord(ctx.rpc, post, rkey);

        const timestamp = Date.now();
        const record = {
          did: env.DID,
          rkey: rkey,
          post: post,
          handle: "anon.psky.social", // TODO: HARDCODED
          indexedAt: timestamp,
        };
        ctx.logger.info(record);
        stream.emit("message", JSON.stringify(record));

        await ctx.db
          .insertInto("posts")
          .values({
            uri: `at://${env.DID}/social.psky.feed.post/${rkey}`,
            post: post,
            account_did: env.DID,
            indexed_at: timestamp,
          })
          .executeTakeFirst();

        return res.status(200).send(record);
      },
    );

    server.get("/subscribe", { websocket: true }, (socket) => {
      const callback = (data: any) => {
        socket.send(String(data));
      };
      stream.on("message", callback);
      socket.on("close", () => {
        stream.removeListener("data", callback);
      });
    });
  });

  server.get<{ Querystring: GetPostsInterface }>(
    "/posts",
    { schema: { querystring: GetPostsSchema } },
    async (req, res) => {
      const posts = await ctx.db
        .selectFrom("posts")
        .orderBy("indexed_at", "desc")
        .limit(req.query.limit)
        .offset(req.query.cursor ?? 0)
        .innerJoin("accounts", "posts.account_did", "accounts.did")
        .selectAll()
        .execute();

      const data = {
        cursor: posts.length + (req.query.cursor ?? 0),
        posts: posts.map((rec) => ({
          did: rec.did,
          rkey: rec.uri.split("/").pop(),
          post: rec.post,
          handle:
            rec.handle === "psky.social" ? "anon.psky.social" : rec.handle,
          nickname: rec.nickname,
          indexedAt: rec.indexed_at,
        })),
      };

      res.code(200).send(data);
    },
  );
};
