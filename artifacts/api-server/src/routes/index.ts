import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import trezuRouter from "./trezu";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(trezuRouter);

export default router;
