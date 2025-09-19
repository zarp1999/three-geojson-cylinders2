import * as THREE from 'three';

/**
 * Scene にパイプ群を追加（ユーティリティ）。
 */
export function addPipesFromGeoJSON(scene, geojson) {
  if (!geojson) return;
  const { group } = buildPipesGroupFromGeoJSON(geojson);
  if (group) scene.add(group);
}

/**
 * GeoJSON からパイプ群を構築し、グループとバウンディングを返す。
 */
export function buildPipesGroupFromGeoJSON(geojson) {
  if (!geojson) return { group: null, bounds: null };

  const features = geojson.type === 'FeatureCollection'
    ? (geojson.features ?? [])
    : geojson.type === 'Feature'
      ? [geojson]
      : [];

  const group = new THREE.Group();
  const bounds = new THREE.Box3();
  let hasAny = false;

  for (const feature of features) {
    const meshes = meshesFromFeature(feature);
    for (const mesh of meshes) {
      group.add(mesh);
      bounds.expandByObject(mesh);
      hasAny = true;
    }
  }

  if (!hasAny) return { group: null, bounds: null };
  return { group, bounds };
}

/**
 * Feature 単位でメッシュ配列を構築（折れ線は隣接ペアごとに分割、点は円弧として表示）。
 */
function meshesFromFeature(feature) {
  const result = [];
  if (!feature?.geometry) return result;

  const g = feature.geometry;
  const type = (g.type || '').toLowerCase();
  const props = feature.properties || {};

  // LineString の処理
  if (type.includes('line') && type.includes('string')) {
    let coords = g.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return result;
    if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0][0])) coords = coords[0];

    for (let i = 0; i < coords.length - 1; i++) {
      const mesh = buildPipeSegment(coords[i], coords[i + 1], props);
      if (mesh) result.push(mesh);
    }
  }
  // Point の処理（_type: "ARC" の場合）
  else if (type === 'point' && props._type === 'ARC') {
    const mesh = buildArcFromPoint(g.coordinates, props);
    if (mesh) result.push(mesh);
  }

  return result;
}

/**
 * 文字列などを数値化。不可なら NaN。
 */
function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v.replace(/[^\d.+\-eE]/g, '').trim());
  return NaN;
}

/**
 * 半径を radius または diameter/2 から決定。mm 推定→m 変換あり。
 */
function chooseRadius(props) {
  const rRaw = props?.radius ?? null;
  const dRaw = props?.diameter ?? null;

  let radius = toNumber(rRaw);
  if (!(isFinite(radius) && radius > 0)) {
    const d = toNumber(dRaw);
    if (isFinite(d) && d > 0) radius = d / 2;
  }
  if (isFinite(radius) && radius > 1.0) radius = radius / 1000;
  return radius;
}

/**
 * レイヤー名から初期色を決める（必要に応じて調整）。
 */
function colorFromLayer(layer) {
  const l = (layer || '').toString().toLowerCase();
  if (l.includes('水道') || l.includes('water')) return 0x1e90ff; // 青
  if (l.includes('下水') || l.includes('sewer')) return 0x8b4513; // 茶
  if (l.includes('ガス') || l.includes('gas')) return 0xff8c00; // 橙
  if (l.includes('電') || l.includes('power') || l.includes('cable')) return 0x696969; // 濃グレー
  return 0x2e8b57; // 緑（既定）
}

/**
 * 材質名ベースの色（フォールバック用）。
 */
function colorFromMaterial(material) {
  const m = (material || '').toString().toLowerCase();
  if (m.includes('pv') || m.includes('pvc')) return 0x1e90ff;
  if (m.includes('con') || m.includes('rc')) return 0x8b8b83;
  if (m.includes('dip') || m.includes('duct') || m.includes('steel') || m.includes('st')) return 0x8888ff;
  return 0x2e8b57;
}

/**
 * 深さの読み取り（未指定は 0 とみなす）。
 */
function readDepth(value) {
  const n = toNumber(value);
  return isFinite(n) ? n : 0;
}

/**
 * Point ジオメトリから円弧メッシュを生成（_type: "ARC" 用）。
 */
function buildArcFromPoint(coordinates, props) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const [x, y] = coordinates;
  const radius = chooseRadius(props);
  if (!(isFinite(radius) && radius > 0)) return null;

  // startAngle と endAngle を取得（ラジアン）
  const startAngle = toNumber(props.startAngle);
  const endAngle = toNumber(props.endAngle);
  
  if (!(isFinite(startAngle) && isFinite(endAngle))) {
    // 角度が無効な場合は円として表示
    return buildCircleFromPoint(coordinates, props);
  }

  // 円弧のジオメトリを作成
  const curve = new THREE.EllipseCurve(
    0, 0, // 中心
    radius, radius, // 半径
    startAngle, endAngle, // 開始・終了角度
    false, // 時計回り
    0 // 回転
  );

  const points = curve.getPoints(50); // 50個の点で円弧を近似
  const geometry = new THREE.BufferGeometry().setFromPoints(points);

  // 線の太さを設定（円柱の半径から推定）
  const lineWidth = Math.max(0.01, radius * 0.1); // 半径の10%を線の太さとする

  // 初期色は layer 優先、なければ material ベース
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  const material = new THREE.LineBasicMaterial({
    color,
    linewidth: lineWidth,
    transparent: true,
    opacity: 0.8
  });

  const mesh = new THREE.Line(geometry, material);

  // 位置を設定（床上）
  mesh.position.set(x, radius, y);

  // 編集・選択用データ
  mesh.userData = mesh.userData || {};
  mesh.userData.properties = { ...props };
  mesh.userData.layer = props.layer ?? '';
  mesh.userData.arcData = { startAngle, endAngle, radius };

  return mesh;
}

/**
 * Point ジオメトリから円メッシュを生成（角度情報がない場合用）。
 */
function buildCircleFromPoint(coordinates, props) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const [x, y] = coordinates;
  const radius = chooseRadius(props);
  if (!(isFinite(radius) && radius > 0)) return null;

  // 円のジオメトリを作成
  const geometry = new THREE.CircleGeometry(radius, 32);

  // 初期色は layer 優先、なければ material ベース
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.6,
    metalness: 0.1,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);

  // 位置を設定（床上）
  mesh.position.set(x, 0.01, y); // 床より少し上に配置
  mesh.rotation.x = -Math.PI / 2; // 水平に配置

  // 編集・選択用データ
  mesh.userData = mesh.userData || {};
  mesh.userData.properties = { ...props };
  mesh.userData.layer = props.layer ?? '';

  return mesh;
}

/**
 * 2 点から 1 本の円柱を生成。
 * 現在は床上表示を優先し、深さは使わず Y は半径・水平配置。
 * 将来のために深さ反映コードをコメントで残す。
 */
function buildPipeSegment(p0, p1, props) {
  const [x1, y1] = p0;
  const [x2, y2] = p1;

  const r = chooseRadius(props);
  if (!(isFinite(r) && r > 0)) return null;

  // --- 深さ反映（将来用）：使用する場合は以下のブロックを有効化 ---
  // const startDepth = readDepth(props.start_point_depth ?? props['start_point depth'] ?? props.start_depth);
  // const endDepth = readDepth(props.end_point_depth ?? props['end_point depth'] ?? props.end_depth);
  // const yCenter1 = -startDepth + r; // 地表=0, 下向きが+ と仮定
  // const yCenter2 = -endDepth + r;
  // const dx = x2 - x1;
  // const dy = yCenter2 - yCenter1;
  // const dz = y2 - y1;
  // const length = Math.hypot(dx, dy, dz);
  // if (length <= 0) return null;
  // const geo = new THREE.CylinderGeometry(r, r, length, 24);
  // const dir = new THREE.Vector3(dx, dy, dz).normalize();
  // const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  // const midX = (x1 + x2) / 2;
  // const midY = (yCenter1 + yCenter2) / 2;
  // const midZ = (y1 + y2) / 2;

  // --- 現行：水平（床上）配置 ---
  const dx = x2 - x1;
  const dz = y2 - y1; // GeoJSON Y -> three.js Z
  const length = Math.hypot(dx, dz);
  if (length <= 0) return null;

  const geo = new THREE.CylinderGeometry(r, r, length, 24);

  // 初期色は layer 優先、なければ material ベース
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.6,
    metalness: 0.1,
    transparent: true,
    opacity: 0.75,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);

  // Y 軸基準の円柱を XZ の方向へ回転
  const dir = new THREE.Vector3(dx, 0, dz).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.quaternion.copy(quat);

  // 中心位置（床上）：Y は半径
  const midX = (x1 + x2) / 2;
  const midZ = (y1 + y2) / 2;
  mesh.position.set(midX, r, midZ);

  // 編集・選択用データ
  mesh.userData = mesh.userData || {};
  mesh.userData.properties = { ...props };
  mesh.userData.endpoints = { x1, y1, x2, y2 };
  mesh.userData.layer = props.layer ?? '';

  return mesh;
}

/**
 * 選択中メッシュの userData を基に形状を再構築。
 * 現在は水平配置に合わせる。深さ対応版はコメント参照。
 * 円弧メッシュの再構築にも対応。
 */
export function rebuildPipeMeshFromUserData(mesh) {
  if (!mesh?.userData) return;
  const props = mesh.userData.properties || {};
  
  // 円弧メッシュの場合
  if (mesh.userData.arcData) {
    rebuildArcMesh(mesh, props);
    return;
  }
  
  // パイプメッシュの場合
  const ep = mesh.userData.endpoints || null;
  if (!ep) return;

  const r = chooseRadius(props);

  // --- 深さ反映（将来用）：使用する場合は以下のブロックを有効化 ---
  // const startDepth = readDepth(props.start_point_depth ?? props['start_point depth'] ?? props.start_depth);
  // const endDepth = readDepth(props.end_point_depth ?? props['end_point depth'] ?? props.end_depth);
  // const yCenter1 = -startDepth + (isFinite(r) ? r : 0);
  // const yCenter2 = -endDepth + (isFinite(r) ? r : 0);
  // const dx3 = ep.x2 - ep.x1;
  // const dy3 = yCenter2 - yCenter1;
  // const dz3 = ep.y2 - ep.y1;
  // const len3 = Math.hypot(dx3, dy3, dz3);
  // if (!(isFinite(len3) && len3 > 0) || !(isFinite(r) && r > 0)) return;
  // const oldGeo3 = mesh.geometry;
  // mesh.geometry = new THREE.CylinderGeometry(r, r, len3, 24);
  // oldGeo3?.dispose && oldGeo3.dispose();
  // const dir3 = new THREE.Vector3(dx3, dy3, dz3).normalize();
  // mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir3);
  // mesh.position.set((ep.x1 + ep.x2) / 2, (yCenter1 + yCenter2) / 2, (ep.y1 + ep.y2) / 2);

  // --- 現行：水平（床上）配置 ---
  const dx = ep.x2 - ep.x1;
  const dz = ep.y2 - ep.y1;
  const len = Math.hypot(dx, dz);
  if (!(isFinite(len) && len > 0) || !(isFinite(r) && r > 0)) return;

  const oldGeo = mesh.geometry;
  mesh.geometry = new THREE.CylinderGeometry(r, r, len, 24);
  oldGeo?.dispose && oldGeo.dispose();

  const dir = new THREE.Vector3(dx, 0, dz).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  mesh.position.set((ep.x1 + ep.x2) / 2, r, (ep.y1 + ep.y2) / 2);

  // 色は layer 優先で更新（透明設定は維持）
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  if (mesh.material && !Array.isArray(mesh.material)) {
    mesh.material.color = new THREE.Color(color);
    mesh.material.transparent = true;
    mesh.material.opacity = 0.75;
    mesh.material.depthWrite = false;
  }
}

/**
 * 円弧メッシュを再構築。
 */
function rebuildArcMesh(mesh, props) {
  const arcData = mesh.userData.arcData;
  if (!arcData) return;

  const radius = chooseRadius(props);
  if (!(isFinite(radius) && radius > 0)) return;

  const startAngle = toNumber(props.startAngle);
  const endAngle = toNumber(props.endAngle);
  
  if (!(isFinite(startAngle) && isFinite(endAngle))) {
    // 角度が無効な場合は円として再構築
    rebuildCircleMesh(mesh, props);
    return;
  }

  // 円弧のジオメトリを再作成
  const curve = new THREE.EllipseCurve(
    0, 0, // 中心
    radius, radius, // 半径
    startAngle, endAngle, // 開始・終了角度
    false, // 時計回り
    0 // 回転
  );

  const points = curve.getPoints(50);
  const oldGeo = mesh.geometry;
  mesh.geometry = new THREE.BufferGeometry().setFromPoints(points);
  oldGeo?.dispose && oldGeo.dispose();

  // 線の太さを更新
  const lineWidth = Math.max(0.01, radius * 0.1);
  if (mesh.material) {
    mesh.material.linewidth = lineWidth;
  }

  // 色を更新
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  if (mesh.material) {
    mesh.material.color = new THREE.Color(color);
  }

  // arcData を更新
  mesh.userData.arcData = { startAngle, endAngle, radius };
}

/**
 * 円メッシュを再構築。
 */
function rebuildCircleMesh(mesh, props) {
  const radius = chooseRadius(props);
  if (!(isFinite(radius) && radius > 0)) return;

  const oldGeo = mesh.geometry;
  mesh.geometry = new THREE.CircleGeometry(radius, 32);
  oldGeo?.dispose && oldGeo.dispose();

  // 色を更新
  const color = colorFromLayer(props.layer) ?? colorFromMaterial(props.material);
  if (mesh.material) {
    mesh.material.color = new THREE.Color(color);
  }
}