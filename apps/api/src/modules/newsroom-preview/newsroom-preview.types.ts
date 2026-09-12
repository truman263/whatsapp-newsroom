export type PreviewClaims = {
  v: 1;
  preparation_id: string;
  story_id: string;
  story_version: number;
  wordpress_applied_version: string;
  exp: number;
};

export type PreviewRender = {
  headline: string;
  editorialByline: string;
  body: string;
  categories: { name: string }[];
  media: { id: string; mimeType: string }[];
};
