import { buildTitle, coreName, titleWeight } from '../packages/xgj-admin/src/keywords';

const names = [
  'ArtCraft AI创作工作台', 'PhotoCraft 开源照片编辑器', 'PdfCraft 开源PDF编辑器', 'LightCraft 无损修图软件',
  'WordCraft 开源文字处理', 'VectorCraft 开源矢量绘图', 'EffectCraft 动效合成工具', 'CADCraft 开源CAD制图',
  'DesignCraft 版面设计工具', 'DeckCraft 开源演示文稿', 'SoundCraft 开源音频工作站', 'FigCraft 界面设计工具',
  'Craft Launcher 启动器', 'ArtCraft 开源创作套件 13个应用',
];
for (const n of names) {
  const t = buildTitle({ display_name: n, category: 'software' });
  console.log(String(titleWeight(t)).padStart(2), '|', t, '|| core=', coreName(n));
}
