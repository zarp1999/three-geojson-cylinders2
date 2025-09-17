import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { addPipesFromGeoJSON } from '../lib/pipes.js';
import { buildPipesGroupFromGeoJSON, rebuildPipeMeshFromUserData } from '../lib/pipes.js';

function ThreeView({ geojsonData, geojsonUrl = '/sample.geojson' }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const [selectedProps, setSelectedProps] = useState(null);
  const selectedMeshRef = useRef(null);

  // レイヤー → 色 のマップ（UI で編集可能）
  const [layerColorMap, setLayerColorMap] = useState({});
  // レイヤー → 表示状態 のマップ（チェックボックス用）
  const [layerVisibilityMap, setLayerVisibilityMap] = useState({});
  // 編集済みメッシュのIDを追跡
  const [editedMeshIds, setEditedMeshIds] = useState(new Set());
  // 編集済みのみ表示フラグ
  const [showOnlyEdited, setShowOnlyEdited] = useState(false);
  const pipesGroupRef = useRef(null);
  const originalGeoJSONRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 100000);
    camera.position.set(0, 400, 600);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = false;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(300, 500, 300);
    scene.add(dir);

    // 床（チラつき抑制設定）
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 1, metalness: 0, transparent: true, opacity: 0.95, depthWrite: true, depthTest: true })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.renderOrder = -1;
    scene.add(floor);

    // 軸非表示、グリッドのみ
    // scene.add(new THREE.AxesHelper(200));
    scene.add(new THREE.GridHelper(5000, 300, 0x888888, 0xcccccc));

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let highlighted = null;
    let originalMaterial = null;

    function clearHighlight() {
      if (highlighted && originalMaterial) {
        highlighted.material = originalMaterial;
      }
      highlighted = null;
      originalMaterial = null;
    }

    function setHighlight(mesh) {
      if (highlighted === mesh) return;
      clearHighlight();
      if (mesh) {
        highlighted = mesh;
        originalMaterial = mesh.material;
        mesh.material = originalMaterial.clone();
        mesh.material.emissive = new THREE.Color(0xffff00);
        mesh.material.emissiveIntensity = 0.6;
      }
    }

    function onClick(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(scene.children, true)
        .filter(hit => hit.object && hit.object.isMesh && hit.object.geometry && hit.object.geometry.type === 'CylinderGeometry');
      if (intersects.length > 0) {
        const mesh = intersects[0].object;
        setHighlight(mesh);
        selectedMeshRef.current = mesh;
        setSelectedProps({ ...(mesh.userData?.properties || {}) });
      } else {
        clearHighlight();
        selectedMeshRef.current = null;
        setSelectedProps(null);
      }
    }

    renderer.domElement.addEventListener('click', onClick);

    // 矢印キー速度をさらに下げる
    const keyState = new Set();
    function onKeyDown(e) { keyState.add(e.key); }
    function onKeyUp(e) { keyState.delete(e.key); }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function updateCameraByKeys(deltaSec = 1 / 60) {
      const move = 40 * deltaSec; // 速度をさらに低速化
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0; forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).negate();
      let moved = false;
      if (keyState.has('ArrowUp')) { camera.position.addScaledVector(forward, move); controls.target.addScaledVector(forward, move); moved = true; }
      if (keyState.has('ArrowDown')) { camera.position.addScaledVector(forward, -move); controls.target.addScaledVector(forward, -move); moved = true; }
      if (keyState.has('ArrowLeft')) { camera.position.addScaledVector(right, -move); controls.target.addScaledVector(right, -move); moved = true; }
      if (keyState.has('ArrowRight')) { camera.position.addScaledVector(right, move); controls.target.addScaledVector(right, move); moved = true; }
      if (moved) controls.update();
    }

    // 入力データの取り扱い: geojsonData が優先、無ければ geojsonUrl からフェッチ（後方互換）
    let cancelled = false;
    const loadAndAdd = (json) => {
      // 元のGeoJSONを保存（エクスポート用）
      originalGeoJSONRef.current = json;
      
      const { group, bounds } = buildPipesGroupFromGeoJSON(json);
      if (group) {
        pipesGroupRef.current = group;
        scene.add(group);

        const colorMap = {};
        const visibilityMap = {};
        group.traverse(obj => {
          if (obj.isMesh && obj.geometry && obj.geometry.type === 'CylinderGeometry') {
            const layer = obj.userData?.layer || '';
            if (layer) {
              if (!colorMap[layer]) {
                colorMap[layer] = '#' + obj.material.color.getHexString();
              }
              if (!(layer in visibilityMap)) {
                visibilityMap[layer] = true; // 初期は表示
              }
            }
          }
        });
        if (Object.keys(colorMap).length > 0) setLayerColorMap(colorMap);
        if (Object.keys(visibilityMap).length > 0) setLayerVisibilityMap(visibilityMap);

        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        bounds.getCenter(center);
        bounds.getSize(size);
        controls.target.copy(center);
        const maxSize = Math.max(size.x, size.y, size.z);
        const fitDist = maxSize * 1.5;
        camera.position.set(center.x + fitDist, center.y + fitDist * 0.6, center.z + fitDist);
        camera.near = Math.max(0.1, maxSize / 1000);
        camera.far = Math.max(1000, maxSize * 50);
        camera.updateProjectionMatrix();
      }
    };

    if (geojsonData) {
      loadAndAdd(geojsonData);
    } else if (geojsonUrl) {
      fetch(geojsonUrl, { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); })
        .then(json => { if (!cancelled) loadAndAdd(json); })
        .catch(e => !cancelled && setError(`GeoJSON load error: ${e.message}`));
    } else {
      setError('GeoJSON が指定されていません。');
    }

    const onResize = () => {
      const { clientWidth, clientHeight } = container;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
    };
    window.addEventListener('resize', onResize);

    let last = performance.now();
    let rafId;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const now = performance.now();
      const delta = (now - last) / 1000;
      last = now;
      updateCameraByKeys(delta);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      renderer.dispose();
      scene.traverse(obj => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose && m.dispose());
          else obj.material?.dispose && obj.material.dispose();
        }
      });
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [geojsonData, geojsonUrl]);

  // レイヤー表示切り替え
  function toggleLayerVisibility(layer) {
    const group = pipesGroupRef.current;
    if (!group) return;
    
    const newVisibility = !layerVisibilityMap[layer];
    setLayerVisibilityMap(prev => ({ ...prev, [layer]: newVisibility }));
    
    group.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.type === 'CylinderGeometry') {
        const objLayer = obj.userData?.layer || '';
        if (objLayer === layer) {
          obj.visible = newVisibility && (!showOnlyEdited || editedMeshIds.has(obj.id));
        }
      }
    });
  }

  // 編集済みのみ表示切り替え
  function toggleShowOnlyEdited() {
    const group = pipesGroupRef.current;
    if (!group) return;
    
    const newShowOnlyEdited = !showOnlyEdited;
    setShowOnlyEdited(newShowOnlyEdited);
    
    group.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.type === 'CylinderGeometry') {
        const objLayer = obj.userData?.layer || '';
        const layerVisible = layerVisibilityMap[objLayer] !== false;
        const isEdited = editedMeshIds.has(obj.id);
        
        if (newShowOnlyEdited) {
          obj.visible = layerVisible && isEdited;
        } else {
          obj.visible = layerVisible;
        }
      }
    });
  }

  // GeoJSONエクスポート
  function exportGeoJSON() {
    const group = pipesGroupRef.current;
    if (!group || !originalGeoJSONRef.current) return;

    // 修正された属性からGeoJSONを再構築
    const features = [];
    group.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.type === 'CylinderGeometry' && obj.userData?.properties) {
        const props = obj.userData.properties;
        const ep = obj.userData.endpoints;
        if (ep) {
          features.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [[ep.x1, ep.y1], [ep.x2, ep.y2]]
            },
            properties: { ...props }
          });
        }
      }
    });

    const geojson = {
      type: 'FeatureCollection',
      features: features
    };

    // ファイルダウンロード
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modified-pipes.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // パネル共通スタイル
  const panelStyle = {
    position: 'absolute',
    top: '10px',
    right: '10px',
    background: 'rgba(255,255,255,0.95)',
    color: '#222',
    padding: '10px 12px',
    borderRadius: '6px',
    maxWidth: '360px',
    fontSize: '12px',
    lineHeight: 1.5,
    boxShadow: '0 2px 6px rgba(0,0,0,0.15)'
  };

  function onChangeField(key, value) {
    const mesh = selectedMeshRef.current;
    if (!mesh) return;
    const next = { ...(mesh.userData?.properties || {}), [key]: value };
    mesh.userData.properties = next;
    setSelectedProps(next);
    rebuildPipeMeshFromUserData(mesh);
    
    // 編集済みとしてマーク
    setEditedMeshIds(prev => new Set([...prev, mesh.id]));
  }

  // レイヤー色変更時に同レイヤーの全メッシュへ反映
  function updateLayerColor(layer, hex) {
    const group = pipesGroupRef.current;
    if (!group) return;
    setLayerColorMap(prev => ({ ...prev, [layer]: hex }));
    const color = new THREE.Color(hex);
    group.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.type === 'CylinderGeometry') {
        const objLayer = obj.userData?.layer || '';
        if (objLayer === layer && obj.material && !Array.isArray(obj.material)) {
          obj.material.color = color.clone();
        }
      }
    });
  }

  const fields = selectedProps ? Object.keys(selectedProps) : [];
  const layerKeys = Object.keys(layerColorMap);

  return React.createElement(
    'div',
    { className: 'three-container', ref: containerRef, style: { position: 'relative' } },

    // 選択オブジェクト編集パネル
    selectedProps && React.createElement(
      'div',
      { style: panelStyle },
      React.createElement('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '選択したオブジェクト（編集可）'),
      fields.map((k) =>
        React.createElement(
          'div',
          { key: k, style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
          React.createElement('label', { style: { width: '40%' } }, k),
          React.createElement('input', {
            style: { flex: 1 },
            value: String(selectedProps[k] ?? ''),
            onChange: (e) => onChangeField(k, e.target.value)
          })
        )
      ),
      React.createElement('div', { style: { fontSize: '11px', color: '#666' } }, '半径: radius, 直径: diameter は mm 推定→m に換算 / 深さは将来対応（コードに保持）。')
    ),

    // レイヤー色編集パネル（表示切り替えも統合）
    layerKeys.length > 0 && React.createElement(
      'div',
      { style: { ...panelStyle, top: 'auto', bottom: '10px' } },
      React.createElement('div', { style: { fontWeight: 700, marginBottom: '6px' } }, 'レイヤー設定'),
      
      // 編集済みのみ表示チェックボックス
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '6px', background: '#f8f9fa', borderRadius: '4px' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: showOnlyEdited,
          onChange: toggleShowOnlyEdited,
          style: { marginRight: '4px' }
        }),
        React.createElement('label', { style: { fontSize: '11px', fontWeight: '600' } }, '編集済みのみ表示')
      ),
      
      layerKeys.map((layer) =>
        React.createElement(
          'div',
          { key: layer, style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: layerVisibilityMap[layer] !== false,
            onChange: () => toggleLayerVisibility(layer),
            style: { marginRight: '4px' }
          }),
          React.createElement('label', { style: { width: '40%', fontSize: '11px' } }, layer || '(レイヤー名なし)'),
          React.createElement('input', {
            type: 'color',
            value: layerColorMap[layer],
            onChange: (e) => updateLayerColor(layer, e.target.value),
            style: { width: '30px', height: '20px' }
          })
        )
      )
    ),

    // GeoJSONエクスポートボタン（左上に移動）
    originalGeoJSONRef.current && React.createElement(
      'div',
      { style: { ...panelStyle, top: '10px', left: '10px', right: 'auto', bottom: 'auto' } },
      React.createElement('button', {
        style: {
          padding: '8px 12px',
          background: '#059669',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: '600'
        },
        onClick: exportGeoJSON
      }, 'GeoJSON エクスポート')
    ),

    error && React.createElement('div', { style: { position: 'absolute', bottom: '10px', left: '10px', color: 'red' } }, error)
  );
}

export default ThreeView;