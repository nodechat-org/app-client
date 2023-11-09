import { parseCSS, preDeclarations } from "./CSSToRN";
import React, { Component, ReactElement, ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Image, Platform, useColorScheme, useWindowDimensions } from "react-native";
import { Rules, Selector } from "./CSSToRN";
import { useAccessibilityInfo } from "./useAccessibilityInfo";
import { useOrientation } from "./useOrientation";
// @ts-ignore
import FosscordTheme from "../assets/themes/fosscord.css";
import { matchQuery } from "./MediaQuery";
import { useDispatch, useSelector } from "react-redux";
import "missing-native-js-functions";
import { observer } from "mobx-react";
import { ThemesContext } from "../data/Themes";

const glob = globalThis as any;
glob.themeCache = [];

export const ComponentStack = React.createContext<Selector[]>([]);

const CSS_VARIABLE = /var\(([\w-]+)\)/;
let wasHotReloaded = false;

export const Themes = observer(function Themes(props: { children: ReactElement }) {
	const { width, height, fontScale, scale } = useWindowDimensions();
	const orientation = useOrientation();
	const colorScheme = "dark" || useColorScheme();
	const accessibilityInfo = useAccessibilityInfo();
	const [theme, setTheme] = useContext(ThemesContext);
	// TODO: suspense show spinning icon (only after a delay to prevent short flashes)

	function refetch() {
		if (typeof FosscordTheme === "object") return;
		fetch(Image.resolveAssetSource(FosscordTheme).uri)
			.then((x) => x.text())
			.then((x) => {
				const start = Date.now();
				glob.themeCache = parseCSS(x);
				// console.log("theme parsing took " + (Date.now() - start) + "ms");
				calculateTheme();
				// console.warn("wasHotReloaded");
			});
	}

	if (!wasHotReloaded) {
		wasHotReloaded = true;
		refetch();
	}

	useEffect(() => {
		if (Platform.OS === "macos") return;
		refetch();
	}, []);

	function calculateTheme() {
		let temp: Rules[] = [];
		let themeCache = glob.themeCache as Rules[];
		themeCache.forEach((x) => {
			if (x.type !== "media") return true;
			if (
				matchQuery(x.media, {
					type: "screen",
					width,
					height,
					"device-width": width,
					"device-height": height,
					orientation,
					"prefers-color-scheme": colorScheme,
					"prefers-reduced-motion": accessibilityInfo.reduceMotion,
					"prefers-reduced-transparency": accessibilityInfo.reduceTransparency,
				})
			) {
				// @ts-ignore
				temp = temp.concat(x.rules);
			} else {
			}
		});
		temp = temp.concat(themeCache.filter((x) => x.type !== "media"));

		// update css variables that are in media queries
		temp = temp
			.sort((a, b) => {
				if (a.selectors?.find((s) => s.find((b) => b.tag === ":root"))) return -1;
				if (b.selectors?.find((s) => s.find((b) => b.tag === ":root"))) return 1;
				return 0;
			})
			.sort((a, b) => Math.max(...(a.selectors?.map((x) => x.length) || [])) - Math.max(...(b.selectors?.map((x) => x.length) || [])))
			.map((r, i) => {
				let rule = { ...r, declarations: { ...r.declarations } };
				Object.entries(rule.declarations || {})?.forEach(([key, value]) => {
					if (key.startsWith("--")) {
						preDeclarations[key] = value;
					} else if (typeof value === "string" && value.includes("var(")) {
						const match = value.match(CSS_VARIABLE);
						if (!match) return;
						rule.declarations[key] = value.replace(CSS_VARIABLE, preDeclarations[match[1]]);
					}
				});
				return rule;
			});

		// console.log("final computed theme:", temp, (glob ).themeCache);
		glob.theme = temp;
		// console.log(temp.map((x) => x.selectors?.map((s) => s.map((c) => "." + c.classes?.join(".")).join(" ")).join(", ")).join("\n"));

		setTheme(temp);
		console.log("rerender themes");
	}

	useEffect(() => {
		if (Platform.OS === "macos") return;
		calculateTheme();
	}, [orientation, colorScheme, width, height]);

	return props.children;
});

const R = React.createElement;

function matchSelector(node: Selector, selector: Selector) {
	if (!node || !selector) return false;

	if (node.id === selector.id && selector.id) return true;
	if ((node.tag === selector.tag && selector.tag) || selector.tag === "*") return true;
	if (selector.classes?.every((x) => node.classes?.includes(x.split(":")[0]))) return true;

	return false;
}

function getTagName(tag: string) {
	if (!tag) return "";
	if ((tag as any)?.displayName) tag = (tag as any).displayName;
	if (typeof tag === "object") return "";

	switch (tag) {
		case "div":
			return "view";
		case "img":
			return "image";
		default:
			return tag
				.toLowerCase()
				.replace("rct", "")
				.replace("rnc", "")
				.replace("virtualtext", "text")
				.replace("textinput", "input")
				.replace("imageview", "image");
	}
}

// force skip is used for > css operators and to skip if the next element does not match it
function matchSelection(stack: Selector[], selection: Selector[], forceSkip?: boolean): boolean {
	if (selection.length > stack.length) {
		// rule can't match as the selector is longer as the real component path
		return false;
	}
	if (selection.length === 0 && stack.length === 0) {
		// component matches selection and parent path -> return true
		return true;
	}

	const i = selection[1]?.tag === ">" ? 1 : 0;
	const selector = selection[0];
	if (!selector) return false;

	for (const [parentI, parent] of stack.entries()) {
		// selection is bigger than actual component path -> abort
		if (selection.length - i > stack.length) return false;

		// check if any parent matches the selection
		if (!matchSelector(parent, selector)) {
			if (forceSkip) return false;
			continue;
		}
		if (forceSkip && selection.length !== stack.length) {
			return false;
		}

		// parent matched path -> check further | early return to skip unecessary checks
		if (matchSelection(stack.slice(parentI + 1), selection.slice(i + 1), i === 1)) return true;
	}

	return false;
}

class StyleProxy extends Component {
	state = { hovered: false, pressed: false };
	element: { tag: string; classes: string[]; id?: string };

	constructor(public props: { component: string; className?: string; id?: string; style?: any; children?: ReactNode }) {
		super(props);
		const tag = getTagName(props.component);
		const className = (props.className || "") + " " + tag;
		this.element = { tag, classes: className.split(" "), id: props.id };
	}

	render() {
		const start = Date.now();
		console.log(this.props.className);

		return (
			<ComponentStack.Consumer>
				{(stack) => (
					<ThemesContext.Consumer>
						{([theme, setTheme]) => {
							const newStack = [...stack, this.element];
							let hasHoverSelector: boolean | undefined = false;
							let hasActiveSelector: boolean | undefined = false;

							const rules = (theme as Rules[]).filter((rule) =>
								rule.selectors?.some((selection) => {
									if (matchSelection(newStack, selection)) {
										hasHoverSelector = hasHoverSelector || selection.some((s) => s.classes?.last()?.includes(":hover"));
										hasActiveSelector =
											hasActiveSelector || selection.some((s) => s.classes?.last()?.includes(":active"));
										if (hasActiveSelector && !this.state.pressed) return false;
										if (hasHoverSelector && !this.state.hovered) return false;
										return true;
									}
								})
							);

							const style =
								rules
									.map((x) => x.declarations)
									.reverse()
									.reduce((value, total) => ({ ...total, ...value }), {}) || {};

							const hovers = hasHoverSelector
								? {
										// @ts-ignore
										onMouseEnter: () => this.setState({ hovered: true }) || this.props.onMouseEnter?.(), // @ts-ignore
										onMouseLeave: () => this.setState({ hovered: false }) || this.props.onMouseLeave?.(),
								  }
								: {};

							const pressers = hasActiveSelector
								? {
										// @ts-ignore
										onPress: () => this.setState({ pressed: true }) || props.onPressOut?.(), // @ts-ignore
										onPressOut: () => this.setState({ pressed: false }) || props.onPressOut?.(),
								  }
								: {};

							// console.log("styling took " + (Date.now() - start) + "ms");
							// console.log(newStack.map((x) => x.classes?.join(".")).join(" -> "), style);
							console.log("use theme for", this.element.classes.join("."), style);

							return (
								<ComponentStack.Provider value={newStack}>
									{R(
										this.props.component,
										{
											...this.props,
											...hovers,
											...pressers,
											style: { ...this.props?.style, ...style },
											children: null,
										},
										this.props.children
									)}
								</ComponentStack.Provider>
							);
						}}
					</ThemesContext.Consumer>
				)}
			</ComponentStack.Consumer>
		);
	}
}

// setting this in react-app-env.d.ts doesn't work
declare module "react" {
	interface Attributes {
		className?: string;
	}
}

declare module "react-native" {
	interface ViewProps {
		className?: string;
	}
}

// prevent override on web and recursion on hot reloading
if (R.name !== "test") {
	if (Platform.OS === "web") {
		// @ts-ignore
		React.createElement = function test(type: any, props: any, ...children: ReactNode[]) {
			if (!props) props = {};
			if (type?.render?.displayName || typeof type === "string") {
				if (!props.className) props.className = "";
				props.className += " " + getTagName(type?.render?.displayName || type);
			}
			return R(type, props, ...children);
		};
	} else {
		// @ts-ignore
		React.createElement = function test(type: any, props: any, ...children: ReactNode[]) {
			if (type !== "RCTView" && type !== "RCTText" && type !== "RNCSafeAreaView" && type !== "RCTImageView") {
				return R(type, props, ...children);
			}

			return R(StyleProxy, { ...props, component: type }, ...children);
		};
	}
}

// @ts-ignore
globalThis.react = React;
