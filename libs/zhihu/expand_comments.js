(() => {
  let count = 0;
  document.querySelectorAll('button').forEach(b => {
    if (b.textContent.includes('条评论') || b.textContent.includes('收起评论')) {
      b.click();
      count++;
    }
  });
  return 'clicked ' + count + ' buttons';
})()
