async function main() {
  setInterval(() => {
    console.error('This is error')
  }, 5000)

  return new Promise(() => {})
}

main().finally(process.exit)
