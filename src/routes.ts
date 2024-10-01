import { FastifyInstance } from "fastify";
import type { AppContext } from "./index.js";
import { countGrapheme } from "unicode-segmenter";
import * as t from "tschema";
import { writeRecords } from "./rpc.js";

const CHARLIMIT = 12;

const PostSchema = t.object({ post: t.string() });
type PostInterface = t.Infer<typeof PostSchema>;

const GetPostsSchema = t.object({
  limit: t.integer({ minimum: 1, maximum: 100, default: 50 }),
});
type GetPostsInterface = t.Infer<typeof GetPostsSchema>;

export const createRouter = (server: FastifyInstance, ctx: AppContext) => {
  server.post<{ Body: PostInterface }>(
    "/post",
    { schema: { body: PostSchema } },
    async (req, res) => {
      const post = req.body.post;

      if (countGrapheme(post) > CHARLIMIT)
        return res.status(400).send("Character limit exceeded.");

      const rkey = await writeRecords(ctx.rpc, post);
      const record = { rkey: rkey, post: post, indexedAt: Date.now() };
      await ctx.db.insertInto("posts").values(record).executeTakeFirst();
      ctx.logger.info(record);

      return res.status(200).send(record);
    },
  );

  server.get<{ Querystring: GetPostsInterface }>(
    "/posts",
    { schema: { querystring: GetPostsSchema } },
    async (req, res) => {
      const posts = await ctx.db
        .selectFrom("posts")
        .orderBy("indexedAt", "desc")
        .limit(req.query.limit)
        .selectAll()
        .execute();

      res.code(200).send(posts);
    },
  );
};
