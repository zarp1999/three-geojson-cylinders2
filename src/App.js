import React, { useRef, useState } from 'react';
import './App.css';
import ThreeView from './components/ThreeView.js';

function App() {
  const [geojsonData, setGeojsonData] = useState(null);
  const [importError, setImportError] = useState(null);
  const fileInputRef = useRef(null);

  function onClickImport() {
    setImportError(null);
    fileInputRef.current?.click();
  }

  function onFileChange(e) {
    setImportError(null);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const json = JSON.parse(text);
        setGeojsonData(json);
      } catch (err) {
        setImportError('GeoJSON の読み込みに失敗しました。ファイル内容を確認してください。');
        console.error(err);
      } finally {
        e.target.value = '';
      }
    };
    reader.onerror = () => {
      setImportError('ファイルの読み込み中にエラーが発生しました。');
      e.target.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  return React.createElement(
    'div',
    { className: 'App' },
    React.createElement('header', { className: 'app-header' }, 'three-geojson-cylinders'),
    React.createElement('div', { className: 'app-content' },
      geojsonData
        ? React.createElement(ThreeView, { geojsonData })
        : React.createElement(
            'div',
            { className: 'import-container' },
            React.createElement('div', { className: 'import-card' },
              React.createElement('div', { className: 'import-title' }, 'GeoJSON をインポート'),
              React.createElement('div', { className: 'import-desc' }, 'ローカルの .geojson / .json ファイルを選択してください'),
              React.createElement('button', { className: 'import-button', onClick: onClickImport }, 'ファイルを選択'),
              importError && React.createElement('div', { className: 'import-error' }, importError),
              React.createElement('input', {
                type: 'file',
                accept: '.geojson,application/geo+json,application/json,.json',
                style: { display: 'none' },
                ref: fileInputRef,
                onChange: onFileChange
              })
            )
          )
    )
  );
}

export default App;
