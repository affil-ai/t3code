import ExpoModulesCore
import UIKit

final class T3SidebarTabBarView: ExpoView, UITabBarDelegate {
  let onSelectionChange = EventDispatcher()
  private let tabBar = UITabBar()
  /** The selected item's tag: 0 Threads, 1 Pulls, 2 Work. */
  var selectedIndex = 0 { didSet { updateSelection() } }
  // fork: work: the Work tab leads the bar on servers that run agents.
  var showsWork = false {
    didSet { if showsWork != oldValue { configureItems() } }
  }
  private var pullRequestIcon: UIImage?
  var selectedColor: UIColor = .systemBlue { didSet { tabBar.tintColor = selectedColor } }
  var appearance = "light" {
    didSet { overrideUserInterfaceStyle = appearance == "dark" ? .dark : .light }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let iconBundle = Bundle(for: Self.self).url(forResource: "T3NativeControlIcons", withExtension: "bundle").flatMap(Bundle.init(url:))
    pullRequestIcon = UIImage(named: "pull-request", in: iconBundle, compatibleWith: nil)?.withRenderingMode(.alwaysTemplate)
    tabBar.itemPositioning = .fill
    tabBar.delegate = self
    addSubview(tabBar)
    configureItems()
  }

  private func configureItems() {
    let threads = UITabBarItem(title: "Threads", image: tabIcon(UIImage(systemName: "text.bubble")), tag: 0)
    threads.selectedImage = tabIcon(UIImage(systemName: "text.bubble.fill"))
    let pulls = UITabBarItem(title: "Pulls", image: tabIcon(pullRequestIcon), tag: 1)
    pulls.accessibilityLabel = "Pull requests"
    var items = [threads, pulls]
    if showsWork {
      let work = UITabBarItem(title: "Work", image: tabIcon(UIImage(systemName: "person.2")), tag: 2)
      work.selectedImage = tabIcon(UIImage(systemName: "person.2.fill"))
      items.insert(work, at: 0)
    }
    tabBar.items = items
    updateSelection()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    tabBar.frame = bounds
    updateSelection()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSelection()
  }

  // Give symbols and bitmap assets the same image box; UIKit otherwise scales symbols independently.
  private func tabIcon(_ image: UIImage?) -> UIImage? {
    guard let image else { return nil }
    let canvas = CGSize(width: 28, height: 28)
    let scale = min(24 / image.size.width, 24 / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return UIGraphicsImageRenderer(size: canvas).image { _ in
      image.draw(in: CGRect(x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2, width: size.width, height: size.height))
    }.withRenderingMode(.alwaysTemplate)
  }

  private func updateSelection() {
    guard let item = tabBar.items?.first(where: { $0.tag == selectedIndex }) else { return }
    guard tabBar.selectedItem !== item else { return }
    tabBar.selectedItem = item
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    onSelectionChange(["index": item.tag])
  }
}
