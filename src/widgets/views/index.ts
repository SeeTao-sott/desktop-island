// 通用界面：主题没专门写的组件就用这里的（放在主题的外框里）
import type { Kind, ViewFactory, DataOf } from "../skins/types";
import { spectrumView } from "./spectrum";
import "./viz.css";

export const FALLBACK: { [K in Kind]?: ViewFactory<DataOf[K]> } = {
  audio: spectrumView,
};
