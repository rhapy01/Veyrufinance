import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trezuRouter from "./trezu";

const router: IRouter = Router();

router.use(healthRouter);
router.use(trezuRouter);

export default router;
